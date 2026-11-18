# Отчёт этапа CODE — итерация 1

## Что сделано

- Добавлен `scripts/cycle-pr-body.mjs`: тело PR в stdout, ничего не пишется на диск.
- Раздел «Проверки» собирается из `gates.1.json`, критерии — из `evidence/criteria.md`.
- Добавлены фикстуры `scripts/fixtures/cycle/pr-body/` и `scripts/cycle-pr-body.test.mjs`.

## Проверки

- `pnpm test:scripts` — зелёный.

## Расхождения с планом

- Этот пункт не должен попадать в «Что сделано» (#249).

## Не проверено

- `pnpm test:int` — нет БД.
