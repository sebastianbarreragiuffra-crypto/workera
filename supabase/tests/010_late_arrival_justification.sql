-- pgTAP Fase 2B: justification_status generado + late_arrival_daily_totals
create extension if not exists pgtap;

begin;
select plan(4);

insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST2B-EMP-LA-001', 'Fixture', 'LA2B', 'Fixture LA2B');

insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-LA-001'),
  date '2026-08-10', timestamptz '2026-08-10 07:43-04', timestamptz '2026-08-10 17:00-04',
  'hash-2b-la-1', 1, true
);

insert into public.late_arrival_records
  (employee_id, work_date, attendance_record_id, scheduled_start, actual_start, detected_minutes, late_arrival_policy_id)
values (
  (select id from public.employees where external_workera_id = 'TEST2B-EMP-LA-001'),
  date '2026-08-10',
  (select id from public.attendance_records where source_hash = 'hash-2b-la-1'),
  time '07:30', timestamptz '2026-08-10 07:43-04', 13,
  (select lap.id from public.late_arrival_policies lap join public.employee_groups eg on eg.id = lap.employee_group_id
     where eg.code = 'PRODUCTION' and lap.day_of_week = 1)
);

insert into public.profiles (display_name, role) values ('Fixture Decisor LA2B', 'supervisor');

-- 1) detected=13, justified=true, payroll=0 (caso del encargo sección 18) se inserta
select lives_ok(
  format(
    $$ insert into public.late_arrival_decisions
         (late_arrival_record_id, justified, payroll_minutes, payroll_effect, reason, decided_by)
       values (%L, true, 0, 'DO_NOT_DEDUCT', 'Problema de transporte', %L) $$,
    (select id from public.late_arrival_records where detected_minutes = 13),
    (select id from public.profiles where display_name = 'Fixture Decisor LA2B')
  ),
  'late_arrival_decisions: detected=13, justified=true, payroll=0 se inserta'
);

-- 2) justification_status se deriva automáticamente a JUSTIFIED (columna generada)
select is(
  (select justification_status from public.late_arrival_decisions lad
     join public.late_arrival_records lar on lar.id = lad.late_arrival_record_id
     where lar.detected_minutes = 13 and lar.employee_id =
       (select id from public.employees where external_workera_id = 'TEST2B-EMP-LA-001')),
  'JUSTIFIED',
  'justification_status se deriva automáticamente de justified=true -> JUSTIFIED'
);

-- 3) No se puede escribir justification_status directamente (columna generada)
select throws_ok(
  format(
    $$ update public.late_arrival_decisions set justification_status = 'PENDING' where late_arrival_record_id = %L $$,
    (select id from public.late_arrival_records where detected_minutes = 13)
  ),
  '428C9',
  null,
  'justification_status no admite escritura directa (es GENERATED)'
);

-- 4) late_arrival_daily_totals expone el detalle diario correctamente
select is(
  (select payroll_minutes from public.late_arrival_daily_totals
     where employee_id = (select id from public.employees where external_workera_id = 'TEST2B-EMP-LA-001')
       and work_date = date '2026-08-10'),
  0,
  'late_arrival_daily_totals: refleja payroll_minutes=0 para el atraso justificado'
);

select * from finish();
rollback;
