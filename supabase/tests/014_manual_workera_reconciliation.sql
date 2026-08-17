-- pgTAP Fase 2B: reconciliación manual/Workera sin duplicación silenciosa
-- (docs/BUSINESS_RULES_PRE_PHASE2.md + encargo Fase 2B secciones 44-46)
create extension if not exists pgtap;

begin;
select plan(4);

insert into public.employees (external_workera_id, first_name, last_name, display_name)
values ('TEST2B-EMP-RECON-001', 'Fixture', 'Reconcile', 'Fixture Reconcile');
insert into public.profiles (display_name, role) values ('Fixture Supervisor Reconcile', 'SUPERVISOR_PRODUCTION');

-- 08:00 — Supervisor registra manualmente una licencia porque Workera no la trajo
select lives_ok(
  format(
    $$ insert into public.attendance_status_records
         (employee_id, work_date, attendance_status_id, source, source_hash, source_version, is_current, created_by, reason)
       values (%L, date '2026-08-10', %L, 'manual', 'hash-recon-manual', 1, true, %L, 'Registrado manualmente, Workera no trajo la licencia') $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-RECON-001'),
    (select id from public.attendance_statuses where code = 'L'),
    (select id from public.profiles where display_name = 'Fixture Supervisor Reconcile')
  ),
  '08:00 — entrada manual de licencia (L) se registra correctamente'
);

-- 14:00 — Workera sincroniza la misma licencia. NO debe poder marcarse como
-- is_current=true silenciosamente mientras la manual sigue vigente: eso
-- crearía dos registros "vigentes" para el mismo día, y el índice único
-- parcial (employee_id, work_date) WHERE is_current lo impide.
select throws_ok(
  format(
    $$ insert into public.attendance_status_records
         (employee_id, work_date, attendance_status_id, source, external_id, source_hash, source_version, is_current)
       values (%L, date '2026-08-10', %L, 'workera', 'WORKERA-STATUS-001', 'hash-recon-workera', 2, true) $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-RECON-001'),
    (select id from public.attendance_statuses where code = 'L')
  ),
  '23505',
  null,
  '14:00 — Workera no puede sobrescribir silenciosamente la entrada manual vigente (UNIQUE parcial is_current)'
);

-- La reconciliación correcta: el registro de Workera se guarda como versión
-- NO vigente (is_current=false) hasta que un humano decida explícitamente cuál
-- prevalece — no se pierde ninguno de los dos, ambos quedan en la base.
select lives_ok(
  format(
    $$ insert into public.attendance_status_records
         (employee_id, work_date, attendance_status_id, source, external_id, source_hash, source_version, is_current)
       values (%L, date '2026-08-10', %L, 'workera', 'WORKERA-STATUS-001', 'hash-recon-workera', 2, false) $$,
    (select id from public.employees where external_workera_id = 'TEST2B-EMP-RECON-001'),
    (select id from public.attendance_statuses where code = 'L')
  ),
  '14:00 — la versión de Workera se guarda como no-vigente (is_current=false), sin fusionarse ni perderse'
);

-- Ambas versiones coexisten: la manual sigue siendo la vigente hasta
-- resolución humana explícita (mismo patrón SYNC_CONFLICT ya usado en Fase 2A).
select is(
  (select count(*)::int from public.attendance_status_records
     where employee_id = (select id from public.employees where external_workera_id = 'TEST2B-EMP-RECON-001')
       and work_date = date '2026-08-10'),
  2,
  'ambas versiones (manual y Workera) coexisten en la base, ninguna se pierde ni se fusiona silenciosamente'
);

select * from finish();
rollback;
