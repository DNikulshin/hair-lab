#!/usr/bin/env bash
# Синхронизация GitHub Projects (доска) с issues репозитория.
#
# Правила:
#   - каждый issue репозитория добавляется на доску, если его там нет;
#   - колонка (поле Status) выводится из меток: status:todo|in-progress|review|blocked;
#   - закрытый issue → Done.
#
# Идемпотентен: повторный запуск ничего не ломает и не дублирует карточки.
# Доска читается одним GraphQL-снимком (`gh api graphql`): id проекта, поле Status
# с опциями и карточки — вместо трёх раздельных вызовов `gh project …` (issue #283).
# Требует scope `project`: gh auth refresh -s project,read:project
#
#   ./scripts/gh-project-sync.sh [номер-проекта]
#
# Переменные:
#   OWNER          владелец проекта (по умолчанию DNikulshin; `@me` — свой аккаунт);
#   REPO           репозиторий с issues (по умолчанию $OWNER/hair-lab);
#   PROJECT_NUMBER номер проекта (по умолчанию 4);
#   LIMIT          сколько issues и карточек читать за раз (по умолчанию 500);
#   DRY_RUN=1      только показать план: в проект ничего не записывается.
set -euo pipefail

OWNER="${OWNER:-DNikulshin}"
REPO="${REPO:-$OWNER/hair-lab}"
PROJECT_NUMBER="${1:-${PROJECT_NUMBER:-4}}"
LIMIT="${LIMIT:-500}"
DRY_RUN="${DRY_RUN:-}"
# GitHub отдаёт не больше 100 узлов на страницу, сколько бы `first` ни просили.
PAGE_SIZE=100

command -v jq >/dev/null || {
  echo "Нужен jq" >&2
  exit 1
}

# `repositoryOwner(login:)` ждёт логин: `@me` резолвим один раз (в workflow владелец
# задан именно так — из соображений прав токена, см. docs/workflow.md).
if [[ "$OWNER" == "@me" ]]; then
  OWNER=$(gh api user --jq .login)
fi

# Колонка по правилам доски. Порядок проверок задаёт приоритет: если на issue висят
# несколько меток статуса, побеждает более поздняя (blocked > in-progress > review).
# Метки приходят из jq через запятую, поэтому сравниваем по границам списка: три `grep`
# на каждый issue — это ~500 лишних процессов за прогон.
desired_status() {
  local state="$1" labels=",$2,"
  if [[ "$state" == "CLOSED" ]]; then
    echo "Done"
    return
  fi
  local status="Todo"
  if [[ "$labels" == *,status:review,* ]]; then status="Review"; fi
  if [[ "$labels" == *,status:in-progress,* ]]; then status="In progress"; fi
  if [[ "$labels" == *,status:blocked,* ]]; then status="Blocked"; fi
  echo "$status"
}

# Снимок доски одним запросом: id проекта, поле Status (id + опции) и карточки.
# Фрагмент один на User и Organization — проекты бывают и личные, и организационные.
SNAPSHOT_QUERY=$(cat <<'GQL'
query ($owner: String!, $number: Int!, $first: Int!, $after: String) {
  repositoryOwner(login: $owner) {
    ... on User { projectV2(number: $number) { ...BoardSnapshot } }
    ... on Organization { projectV2(number: $number) { ...BoardSnapshot } }
  }
}

fragment BoardSnapshot on ProjectV2 {
  id
  statusField: field(name: "Status") {
    ... on ProjectV2SingleSelectField {
      id
      options { id name }
    }
  }
  items(first: $first, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      content { __typename ... on Issue { number } }
      status: fieldValueByName(name: "Status") {
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
    }
  }
}
GQL
)

# "номер issue → id карточки / статус", собирается постранично.
declare -A item_id item_status
declare -A status_option
project_id=""
status_field_id=""
board_total=0
after=""
pages=0

while :; do
  args=(
    -f "query=$SNAPSHOT_QUERY"
    -f "owner=$OWNER"
    -F "number=$PROJECT_NUMBER"
    -F "first=$PAGE_SIZE"
  )
  [[ -n "$after" ]] && args+=(-f "after=$after")
  page=$(gh api graphql "${args[@]}")

  # null вместо проекта — ошибка владельца/номера, иначе дальше пойдёт пустой снимок
  # и синк «успешно» не сделает ничего.
  jq -e '.data.repositoryOwner.projectV2' >/dev/null <<<"$page" || {
    echo "Проект #$PROJECT_NUMBER у владельца $OWNER не найден" >&2
    exit 1
  }

  if [[ -z "$project_id" ]]; then
    project_id=$(jq -r '.data.repositoryOwner.projectV2.id' <<<"$page")
    status_field_id=$(jq -r '.data.repositoryOwner.projectV2.statusField.id // empty' <<<"$page")
    [[ -n "$status_field_id" ]] || {
      echo "В проекте нет поля Status" >&2
      exit 1
    }
    while IFS=$'\t' read -r id name; do
      status_option["$name"]="$id"
    done < <(jq -r '.data.repositoryOwner.projectV2.statusField.options[] | "\(.id)\t\(.name)"' <<<"$page")
  fi

  # totalCount виден только вместе с первой страницей: иначе `--limit` молча урезал бы
  # выдачу и синк «потерял» часть карточек, ничем не показав это.
  board_total=$(jq -r '.data.repositoryOwner.projectV2.items.totalCount // 0' <<<"$page")
  if ((board_total > LIMIT)); then
    echo "На доске $board_total карточек при LIMIT=$LIMIT — выдача усечена, синк отменён." >&2
    echo "Запустите с LIMIT=$((board_total + 100))." >&2
    exit 1
  fi

  while IFS=$'\t' read -r number id status; do
    [[ -z "$number" ]] && continue
    item_id["$number"]="$id"
    item_status["$number"]="$status"
  done < <(
    jq -r '.data.repositoryOwner.projectV2.items.nodes[]
      | select(.content.__typename == "Issue")
      | "\(.content.number)\t\(.id)\t\(.status.name // "")"' <<<"$page"
  )

  pages=$((pages + 1))
  [[ "$(jq -r '.data.repositoryOwner.projectV2.items.pageInfo.hasNextPage' <<<"$page")" == "true" ]] || break
  after=$(jq -r '.data.repositoryOwner.projectV2.items.pageInfo.endCursor' <<<"$page")
  if ((pages * PAGE_SIZE >= LIMIT)); then
    echo "Доска не дочитана за $pages страниц при LIMIT=$LIMIT — синк отменён." >&2
    exit 1
  fi
done

for required in Todo "In progress" Review Blocked Done; do
  [[ -n "${status_option[$required]:-}" ]] || {
    echo "В поле Status нет опции «$required»" >&2
    exit 1
  }
done

# Список issues читаем в переменную: ошибка `gh` под `set -e` должна прервать прогон,
# а не превратиться в пустой список и «успешную» синхронизацию без карточек.
issues=$(gh issue list --repo "$REPO" --state all --limit "$LIMIT" --json number,state,labels,url \
  --jq '.[] | "\(.number)\t\(.state)\t\([.labels[].name] | join(","))\t\(.url)"')
issue_count=$(grep -c . <<<"$issues" || true)
if ((issue_count >= LIMIT)); then
  echo "В репозитории $issue_count issues при LIMIT=$LIMIT — выдача усечена, синк отменён." >&2
  echo "Запустите с LIMIT=$((LIMIT * 2))." >&2
  exit 1
fi

added=0
updated=0
unchanged=0

while IFS=$'\t' read -r number state labels url; do
  [[ -z "$number" ]] && continue
  desired=$(desired_status "$state" "$labels")
  id="${item_id[$number]:-}"

  if [[ -z "$id" ]]; then
    added=$((added + 1))
    if [[ -n "$DRY_RUN" ]]; then
      echo "добавить   #$number → $desired"
      continue
    fi
    id=$(gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" --format json --jq .id)
    item_id["$number"]="$id"
    # Новая карточка создаётся без Status: колонку проставляем сразу, иначе следующий
    # прогон увидит её как «изменённую» повторно.
    gh project item-edit \
      --project-id "$project_id" \
      --id "$id" \
      --field-id "$status_field_id" \
      --single-select-option-id "${status_option[$desired]}" >/dev/null
    continue
  fi

  if [[ "${item_status[$number]:-}" == "$desired" ]]; then
    unchanged=$((unchanged + 1))
    continue
  fi

  updated=$((updated + 1))
  if [[ -n "$DRY_RUN" ]]; then
    echo "перенести  #$number: ${item_status[$number]:-—} → $desired"
    continue
  fi
  gh project item-edit \
    --project-id "$project_id" \
    --id "$id" \
    --field-id "$status_field_id" \
    --single-select-option-id "${status_option[$desired]}" >/dev/null
done <<<"$issues"

summary="Доска #$PROJECT_NUMBER: добавлено $added, обновлено $updated, без изменений $unchanged."
if [[ -n "$DRY_RUN" ]]; then
  echo "$summary DRY_RUN: записей $((added + updated)) не выполнено."
else
  echo "$summary"
fi
