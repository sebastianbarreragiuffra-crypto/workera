-- pgTAP: períodos (weekly_reviews) e idempotencia de IDs externos
create extension if not exists pgtap;

begin;
select plan(4);

-- 1) weekly_reviews: period_end < period_start debe rechazarse
select throws_ok(
  $$ insert into public.weekly_reviews (period_start, period_end)
     values (date '2026-08-17', date '2026-08-10') $$,
  '23514',
  null,
  'weekly_reviews: period_end < period_start es rechazado'
);

-- 2) weekly_reviews: períodos solapados deben rechazarse (EXCLUDE)
insert into public.weekly_reviews (period_start, period_end) values (date '2026-08-01', date '2026-08-07');
select throws_ok(
  $$ insert into public.weekly_reviews (period_start, period_end)
     values (date '2026-08-05', date '2026-08-12') $$,
  '23P01',
  null,
  'weekly_reviews: período solapado con uno existente es rechazado'
);

-- 3) attendance_records: mismo (source, external_id) dos veces debe rechazarse
--    (idempotencia real cuando Workera entrega un id de registro estable)
insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST-EMP-SRC-001', 'Fixture', 'SourceId', 'Fixture SourceId');

insert into public.attendance_records
  (employee_id, work_date, source, external_id, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-SRC-001'),
  date '2026-08-10', 'workera', 'WORKERA-ATT-001', 'hash-src-1', 1, true
);

select throws_ok(
  format(
    $$ insert into public.attendance_records
         (employee_id, work_date, source, external_id, source_hash, source_version, is_current)
       values (%L, date '2026-08-11', 'workera', 'WORKERA-ATT-001', 'hash-src-2', 1, true) $$,
    (select id from public.employees where external_workera_id = 'TEST-EMP-SRC-001')
  ),
  '23505',
  null,
  'attendance_records: (source, external_id) duplicado es rechazado, incluso en otra fecha'
);

-- 4) absence_records: mismo (source, external_id) dos veces debe rechazarse
insert into public.absence_records
  (employee_id, absence_type_id, start_date, end_date, source, external_id, source_hash)
values (
  (select id from public.employees where external_workera_id = 'TEST-EMP-SRC-001'),
  (select id from public.absence_types where code = 'VACATION'),
  date '2026-09-01', date '2026-09-10', 'workera', 'WORKERA-ABS-001', 'hash-abs-1'
);

select throws_ok(
  format(
    $$ insert into public.absence_records
         (employee_id, absence_type_id, start_date, end_date, source, external_id, source_hash)
       values (%L, %L, date '2026-10-01', date '2026-10-05', 'workera', 'WORKERA-ABS-001', 'hash-abs-2') $$,
    (select id from public.employees where external_workera_id = 'TEST-EMP-SRC-001'),
    (select id from public.absence_types where code = 'VACATION')
  ),
  '23505',
  null,
  'absence_records: (source, external_id) duplicado es rechazado'
);

select * from finish();
rollback;
