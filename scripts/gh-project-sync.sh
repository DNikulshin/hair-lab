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
# Переменные: OWNER (по умолчанию DNikulshin), REPO, PROJECT_NUMBER.
set -euo pipefail

OWNER="${OWNER:-DNikulshin}"
REPO="${REPO:-$OWNER/hair-lab}"
PROJECT_NUMBER="${1:-${PROJECT_NUMBER:-4}}"

command -v jq >/dev/null || {
  echo "Нужен jq" >&2
  exit 1
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

# Текущее состояние доски: "номер issue → id карточки / статус"
declare -A item_id item_status
while IFS=$'\t' read -r number id status; do
  [[ -z "$number" ]] && continue
  item_id["$number"]="$id"
  item_status["$number"]="$status"
done < <(
  gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --format json --limit 500 |
    jq -r '.items[] | select(.content.type == "Issue")
      | "\(.content.number)\t\(.id)\t\(.status // "")"'
)

added=0 updated=0 unchanged=0

while IFS=$'\t' read -r number state labels url; do
  case "$state" in
    CLOSED) desired=Done ;;
    *)
      desired=Todo
      grep -q 'status:review' <<<"$labels" && desired=Review
      grep -q 'status:in-progress' <<<"$labels" && desired="In progress"
      grep -q 'status:blocked' <<<"$labels" && desired=Blocked
      ;;
  esac

  id="${item_id[$number]:-}"
  if [[ -z "$id" ]]; then
    id=$(gh project item-add "$PROJECT_NUMBER" --owner "$OWNER" --url "$url" --format json --jq .id)
    item_id["$number"]="$id"
    added=$((added + 1))
  fi

  if [[ "${item_status[$number]:-}" == "$desired" ]]; then
    unchanged=$((unchanged + 1))
    continue
  fi

  gh project item-edit \
    --project-id "$project_id" \
    --id "$id" \
    --field-id "$status_field_id" \
    --single-select-option-id "${status_option[$desired]}" >/dev/null
  updated=$((updated + 1))
done < <(
  gh issue list --repo "$REPO" --state all --limit 500 --json number,state,labels,url \
    --jq '.[] | "\(.number)\t\(.state)\t\([.labels[].name] | join(","))\t\(.url)"'
)

echo "Доска #$PROJECT_NUMBER: добавлено $added, обновлено $updated, без изменений $unchanged."
