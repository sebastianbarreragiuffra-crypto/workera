-- pgTAP Fase 2B: reporting_periods + relación con weekly_reviews + exports
create extension if not exists pgtap;

begin;
select plan(5);

-- 1) period_end < period_start debe rechazarse
select throws_ok(
  $$ insert into public.reporting_periods (period_start, period_end)
     values (date '2026-08-31', date '2026-08-01') $$,
  '23514',
  null,
  'reporting_periods: period_end < period_start es rechazado'
);

-- 2) Período válido (~1 mes) se inserta
select lives_ok(
  $$ insert into public.reporting_periods (period_start, period_end)
     values (date '2026-08-01', date '2026-08-31') $$,
  'reporting_periods: período de ~1 mes se inserta'
);

-- 3) Período solapado debe rechazarse
select throws_ok(
  $$ insert into public.reporting_periods (period_start, period_end)
     values (date '2026-08-15', date '2026-09-15') $$,
  '23P01',
  null,
  'reporting_periods: solapamiento con un período existente es rechazado'
);

-- 4) WeeklyReview puede pertenecer a un ReportingPeriod
insert into public.weekly_reviews (period_start, period_end, reporting_period_id)
values (
  date '2026-08-01', date '2026-08-07',
  (select id from public.reporting_periods where period_start = date '2026-08-01')
);
select is(
  (select rp.status from public.weekly_reviews wr
     join public.reporting_periods rp on rp.id = wr.reporting_period_id
     where wr.period_start = date '2026-08-01' and wr.period_end = date '2026-08-07'),
  'OPEN',
  'weekly_reviews.reporting_period_id relaciona correctamente con reporting_periods'
);

-- 5) excel_exports: WEEKLY_CHECK y FINAL_PERIOD exigen sus propias referencias
insert into public.profiles (display_name, role) values ('Fixture Exporter', 'ADMIN_RRHH');
insert into public.weekly_review_snapshots (weekly_review_id, generated_by, payload)
values (
  (select id from public.weekly_reviews where period_start = date '2026-08-01' and period_end = date '2026-08-07'),
  (select id from public.profiles where display_name = 'Fixture Exporter'),
  '{}'::jsonb
);

select throws_ok(
  format(
    $$ insert into public.excel_exports
         (weekly_review_id, snapshot_id, generated_by, template_version, validation_status, export_scope,
          reporting_period_id, period_snapshot_id)
       values (%L, %L, %L, 'v1', 'PASSED', 'FINAL_PERIOD', null, null) $$,
    (select id from public.weekly_reviews where period_start = date '2026-08-01' and period_end = date '2026-08-07'),
    (select id from public.weekly_review_snapshots limit 1),
    (select id from public.profiles where display_name = 'Fixture Exporter')
  ),
  '23514',
  null,
  'excel_exports: export_scope=FINAL_PERIOD con referencias de WEEKLY_CHECK es rechazado (CHECK)'
);

select * from finish();
rollback;
