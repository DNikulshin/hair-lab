---
description: Цикл plan → code → review по задаче (фикстура check-harness)
---

Этапы автомата: INIT → PLAN → CODE → GATES → QA_WEB → REVIEW → EVALUATE → DECIDE → REWORK →
ACQUIRE_EVIDENCE → PR → DONE; тупик — ESCALATED.

Каждый этап выполняется отдельным субагентом из `.pi/agents/`.
