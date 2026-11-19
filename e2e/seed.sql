-- Каталог для E2E: только вымышленные данные (issue #114).
-- Накатывается на временную базу прогона, dev-базу не трогает. Повторный запуск безопасен:
-- id фиксированные, вставка — ON CONFLICT DO NOTHING.

INSERT INTO service_categories (id, name, is_active, sort_order, created_at, updated_at)
VALUES ('e2e00000-0000-4000-8000-000000000001', 'E2E категория', true, 0, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO services (id, name, description, duration_min, price_kopecks, is_active, sort_order, category_id, created_at, updated_at)
VALUES (
  'e2e00000-0000-4000-8000-000000000002',
  'E2E стрижка',
  'Услуга для браузерных тестов',
  60,
  350000,
  true,
  0,
  'e2e00000-0000-4000-8000-000000000001',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO masters (id, full_name, bio, photo_url, is_active, created_at, updated_at)
VALUES ('e2e00000-0000-4000-8000-000000000003', 'E2E Мастер', NULL, NULL, true, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO master_services (master_id, service_id)
VALUES ('e2e00000-0000-4000-8000-000000000003', 'e2e00000-0000-4000-8000-000000000002')
ON CONFLICT (master_id, service_id) DO NOTHING;

-- Рабочие часы на каждый день недели: 10:00–20:00. Слоты считаются от них,
-- поэтому тест может выбрать завтрашнюю дату в любой день недели.
INSERT INTO master_working_hours (id, master_id, day_of_week, start_minute, end_minute)
SELECT
  ('e2e00000-0000-4000-8000-00000000010' || day)::uuid,
  'e2e00000-0000-4000-8000-000000000003',
  day,
  600,
  1200
FROM generate_series(0, 6) AS day
ON CONFLICT (master_id, day_of_week, start_minute) DO NOTHING;
