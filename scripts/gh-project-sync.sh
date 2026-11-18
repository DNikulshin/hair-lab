#!/usr/bin/env bash
# Синхронизация GitHub Projects (доска) с issues репозитория.
#
# Правила:
#   - каждый issue репозитория добавляется на доску, если его там нет;
#   - колонка (поле Status) выводится из меток: status:todo|in-progress|review|blocked;
#   - закрытый issue → Done.
#
# Идемпотентен: повторный запуск ничего не ломает и не дублирует карточки.
# Требует scope `project`: gh auth refresh -s project,read:project
#
#   ./scripts/gh-project-sync.sh [номер-проекта]
#
# Переменные:
#   OWNER          владелец проекта (по умолчанию DNikulshin);
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

command -v jq >/dev/null || {
  echo "Нужен jq" >&2
  exit 1
}

# Колонка по правилам доски. Порядок проверок задаёт приоритет: если на issue висят
# несколько меток статуса, побеждает более поздняя (blocked > in-progress > review).
desired_status() {
  local state="$1" labels="$2"
  if [[ "$state" == "CLOSED" ]]; then
    echo "Done"
    return
  fi
  local status="Todo"
  grep -q 'status:review' <<<"$labels" && status="Review"
  grep -q 'status:in-progress' <<<"$labels" && status="In progress"
  grep -q 'status:blocked' <<<"$labels" && status="Blocked"
  echo "$status"
}

project_id=$(gh project view "$PROJECT_NUMBER" --owner "$OWNER" --format json --jq .id)

fields=$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json)
status_field_id=$(jq -r '.fields[] | select(.name == "Status") | .id' <<<"$fields")
[[ -n "$status_field_id" ]] || {
  echo "В проекте нет поля Status" >&2
  exit 1
}

declare -A status_option
while IFS=$'\t' read -r id name; do
  status_option["$name"]="$id"
done < <(jq -r '.fields[] | select(.name == "Status") | .options[] | "\(.id)\t\(.name)"' <<<"$fields")

for required in Todo "In progress" Review Blocked Done; do
  [[ -n "${status_option[$required]:-}" ]] || {
    echo "В поле Status нет опции «$required»" >&2
    exit 1
  }
done

# Текущее состояние доски: "номер issue → id карточки / статус".
# Читаем JSON целиком, чтобы увидеть totalCount: иначе `--limit` молча урежет выдачу
# и синк «потеряет» часть issues, ничем не показав это.
board_json=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit "$LIMIT")
board_total=$(jq -r '.totalCount // 0' <<<"$board_json")
if ((board_total > LIMIT)); then
  echo "На доске $board_total карточек при LIMIT=$LIMIT — выдача усечена, синк отменён." >&2
  echo "Запустите с LIMIT=$((board_total + 100))." >&2
  exit 1
fi

declare -A item_id item_status
while IFS=$'\t' read -r number id status; do
  [[ -z "$number" ]] && continue
  item_id["$number"]="$id"
  item_status["$number"]="$status"
done < <(
  jq -r '.items[] | select(.content.type == "Issue")
    | "\(.content.number)\t\(.id)\t\(.status // "")"' <<<"$board_json"
)

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
