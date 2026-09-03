-- pgTAP Fase 6A: ingesta cruda de eventos de marcación Workera
-- (workera_attendance_events) — persistencia, idempotencia a nivel de BD,
-- versionado no destructivo, inmutabilidad del origen incluso para
-- SUPER_ADMIN, integridad de identidad de empleado, y metadata de sync_runs.
create extension if not exists pgtap;

begin;
select plan(26);

-- Compatibilidad de los fixtures históricos de Fase 6A. Producción no tiene
-- default: el job real debe declarar siempre su empresa.
alter table public.sync_runs alter column company_id
  set default '0a4c0000-0000-0000-0000-000000000001'::uuid;

-- ---------------------------------------------------------------------------
-- Fixtures: 1 SUPER_ADMIN, 1 ADMIN_RRHH, 1 supervisor de cada grupo, 1
-- empleado, 1 sync_run base para asociar los eventos crudos.
insert into public.profiles (id, display_name, role) values
  ('91000000-0000-0000-0000-000000000001', 'Fixture 6A Super Admin', 'SUPER_ADMIN'),
  ('91000000-0000-0000-0000-000000000002', 'Fixture 6A RRHH', 'ADMIN_RRHH'),
  ('91000000-0000-0000-0000-000000000003', 'Fixture 6A Supervisor Prod', 'SUPERVISOR_PRODUCTION'),
  ('91000000-0000-0000-0000-000000000004', 'Fixture 6A Supervisor Install', 'SUPERVISOR_INSTALLATION');

insert into public.employees (id, external_workera_id, first_name, last_name, display_name, employee_group_id)
values
  ('91000000-0000-0000-0000-00000000a001', 'S6A-PROD-001', 'Fixture', 'Prod6A', 'Fixture Prod6A',
    (select id from public.employee_groups where code = 'PRODUCTION'));

insert into public.sync_runs (id, status, target_period_start, target_period_end, records_read, records_created)
values ('91000000-0000-0000-0000-00000000b001', 'SUCCEEDED', current_date, current_date, 1, 1);

-- ---------------------------------------------------------------------------
-- 1) Persistencia de un evento crudo válido.
set local role service_role;

insert into public.workera_attendance_events
  (employee_id, external_employee_code, attendance_timestamp_raw, attendance_type_code,
   attendance_type_label, attendance_status, external_attendance_status, origin_code, sync_run_id)
values
  ('91000000-0000-0000-0000-00000000a001', 'S6A-PROD-001', '2026-08-18T08:01:00', 0,
   'ENTRADA', 'ACTIVO', 'ACTIVO', 'RELOJ', '91000000-0000-0000-0000-00000000b001');

select is(
  (select count(*)::int from public.workera_attendance_events
    where external_employee_code = 'S6A-PROD-001'),
  1,
  'INSERT de un evento crudo válido persiste exactamente 1 fila'
);

-- ---------------------------------------------------------------------------
-- 2) work_date derivado correctamente del timestamp crudo (sin aritmética,
--    solo la porción de fecha del string).
select is(
  (select work_date from public.workera_attendance_events
    where external_employee_code = 'S6A-PROD-001'),
  '2026-08-18'::date,
  'work_date se deriva de los primeros 10 caracteres de attendance_timestamp_raw'
);

-- ---------------------------------------------------------------------------
-- 3) attendance_timestamp_interpreted usa AT TIME ZONE America/Santiago
--    (agosto = invierno chileno = UTC-4), nunca un offset hardcodeado.
select is(
  (select attendance_timestamp_interpreted at time zone 'utc' from public.workera_attendance_events
    where external_employee_code = 'S6A-PROD-001'),
  '2026-08-18 12:01:00'::timestamp,
  'attendance_timestamp_interpreted convierte correctamente vía AT TIME ZONE America/Santiago (UTC-4 en invierno)'
);

-- ---------------------------------------------------------------------------
-- 4) attendance_timestamp_raw se preserva exactamente, sin modificar.
select is(
  (select attendance_timestamp_raw from public.workera_attendance_events
    where external_employee_code = 'S6A-PROD-001'),
  '2026-08-18T08:01:00',
  'attendance_timestamp_raw preserva el string original de Workera sin modificar'
);

-- ---------------------------------------------------------------------------
-- 5) Identidad de empleado: employee_id referencia una fila real de
--    employees (no un texto suelto), integridad de FK garantizada.
select is(
  (select e.external_workera_id from public.workera_attendance_events wae
    join public.employees e on e.id = wae.employee_id
    where wae.external_employee_code = 'S6A-PROD-001'),
  'S6A-PROD-001',
  'employee_id resuelve correctamente a employees.external_workera_id vía FK'
);

-- ---------------------------------------------------------------------------
-- 6) Duplicado exacto (mismo fingerprint) sobre una fila is_current=true
--    es rechazado por el índice único parcial — idempotencia garantizada a
--    nivel de BD, no solo de aplicación.
select throws_ok(
  $$ insert into public.workera_attendance_events
       (employee_id, external_employee_code, attendance_timestamp_raw, attendance_type_code,
        attendance_type_label, attendance_status, external_attendance_status, origin_code, sync_run_id)
     values
       ('91000000-0000-0000-0000-00000000a001', 'S6A-PROD-001', '2026-08-18T08:01:00', 0,
        'ENTRADA', 'ACTIVO', 'ACTIVO', 'RELOJ', '91000000-0000-0000-0000-00000000b001') $$,
  '23505',
  null,
  'un evento con fingerprint idéntico a una fila vigente es rechazado por workera_attendance_events_fingerprint_current_key'
);

-- ---------------------------------------------------------------------------
-- 7) Versionado no destructivo: un evento reportado MODIFICADO no
--    sobrescribe la fila anterior — la anterior pasa a is_current=false y
--    se inserta una fila nueva con source_version+1.
update public.workera_attendance_events
  set is_current = false
  where external_employee_code = 'S6A-PROD-001' and source_version = 1;

insert into public.workera_attendance_events
  (employee_id, external_employee_code, attendance_timestamp_raw, attendance_type_code,
   attendance_type_label, attendance_status, external_attendance_status, origin_code, sync_run_id,
   source_version)
values
  ('91000000-0000-0000-0000-00000000a001', 'S6A-PROD-001', '2026-08-18T08:01:00', 0,
   'ENTRADA', 'MODIFICADO', 'MODIFICADO', 'RELOJ', '91000000-0000-0000-0000-00000000b001', 2);

select is(
  (select count(*)::int from public.workera_attendance_events
    where external_employee_code = 'S6A-PROD-001'),
  2,
  'versionado no destructivo: la fila original se preserva (is_current=false) y se agrega una fila nueva, nunca se borra'
);

select is(
  (select count(*)::int from public.workera_attendance_events
    where external_employee_code = 'S6A-PROD-001' and is_current = true),
  1,
  'exactamente 1 fila vigente (is_current=true) por evento tras versionar'
);

select is(
  (select attendance_status from public.workera_attendance_events
    where external_employee_code = 'S6A-PROD-001' and is_current = true),
  'MODIFICADO',
  'la fila vigente refleja el estado MODIFICADO reportado por Workera'
);

-- ---------------------------------------------------------------------------
-- 8) Evento INACTIVO también se preserva (no se borra físicamente) — mismo
--    patrón de versionado, no un caso especial.
update public.workera_attendance_events
  set is_current = false
  where external_employee_code = 'S6A-PROD-001' and source_version = 2;

insert into public.workera_attendance_events
  (employee_id, external_employee_code, attendance_timestamp_raw, attendance_type_code,
   attendance_type_label, attendance_status, external_attendance_status, origin_code, sync_run_id,
   source_version)
values
  ('91000000-0000-0000-0000-00000000a001', 'S6A-PROD-001', '2026-08-18T08:01:00', 0,
   'ENTRADA', 'INACTIVO', 'INACTIVO', 'RELOJ', '91000000-0000-0000-0000-00000000b001', 3);

select is(
  (select count(*)::int from public.workera_attendance_events
    where external_employee_code = 'S6A-PROD-001'),
  3,
  'un evento INACTIVO se preserva como fila nueva versionada, nunca elimina el historial previo'
);

-- ---------------------------------------------------------------------------
-- 9) attendance_type_code fuera de rango (0-5) es rechazado.
select throws_ok(
  $$ insert into public.workera_attendance_events
       (employee_id, external_employee_code, attendance_timestamp_raw, attendance_type_code,
        attendance_type_label, attendance_status, external_attendance_status, sync_run_id)
     values
       ('91000000-0000-0000-0000-00000000a001', 'S6A-PROD-001', '2026-08-18T09:00:00', 9,
        'DESCONOCIDO', 'ACTIVO', 'ACTIVO', '91000000-0000-0000-0000-00000000b001') $$,
  '23514',
  null,
  'attendance_type_code fuera del rango 0-5 es rechazado por workera_attendance_events_type_range_chk'
);

-- ---------------------------------------------------------------------------
-- 10) Inmutabilidad del origen — ni SUPER_ADMIN, ni ADMIN_RRHH, ni ningún
--     supervisor pueden modificar una columna que no sea is_current, sobre
--     un evento crudo de Workera. Se prueba contra los 4 roles reales.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000001'; -- SUPER_ADMIN

select throws_ok(
  $$ update public.workera_attendance_events
       set attendance_status = 'HACKEADO'
       where external_employee_code = 'S6A-PROD-001' and is_current = true $$,
  '42501',
  null,
  'SUPER_ADMIN NO puede modificar un evento crudo de Workera (denegado por falta de GRANT de escritura para authenticated)'
);

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000002'; -- ADMIN_RRHH

select throws_ok(
  $$ update public.workera_attendance_events
       set attendance_status = 'HACKEADO'
       where external_employee_code = 'S6A-PROD-001' and is_current = true $$,
  '42501',
  null,
  'ADMIN_RRHH NO puede modificar un evento crudo de Workera'
);

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000003'; -- SUPERVISOR_PRODUCTION

select throws_ok(
  $$ update public.workera_attendance_events
       set attendance_status = 'HACKEADO'
       where external_employee_code = 'S6A-PROD-001' and is_current = true $$,
  '42501',
  null,
  'SUPERVISOR_PRODUCTION NO puede modificar un evento crudo de Workera'
);

set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000004'; -- SUPERVISOR_INSTALLATION

select throws_ok(
  $$ update public.workera_attendance_events
       set attendance_status = 'HACKEADO'
       where external_employee_code = 'S6A-PROD-001' and is_current = true $$,
  '42501',
  null,
  'SUPERVISOR_INSTALLATION NO puede modificar un evento crudo de Workera'
);

-- ---------------------------------------------------------------------------
-- 11) Ni siquiera service_role (bypassa RLS) puede tocar una columna
--     inmutable distinta de is_current — el trigger enforce_immutable_columns
--     aplica independientemente de RLS.
reset role;
set local role service_role;

select throws_ok(
  $$ update public.workera_attendance_events
       set attendance_status = 'HACKEADO'
       where external_employee_code = 'S6A-PROD-001' and is_current = true $$,
  'P0001',
  null,
  'ni siquiera service_role puede modificar columnas inmutables de un evento crudo (solo is_current puede cambiar)'
);

-- ---------------------------------------------------------------------------
-- 12) service_role SÍ puede modificar la única columna mutable (is_current)
--     — es el mecanismo de versionado, no un agujero de seguridad.
select lives_ok(
  $$ update public.workera_attendance_events
       set is_current = is_current
       where external_employee_code = 'S6A-PROD-001' and is_current = true $$,
  'service_role puede escribir is_current (única columna mutable, mecanismo de versionado)'
);

-- ---------------------------------------------------------------------------
-- 13) No hay borrado físico posible: ningún rol tiene privilegio DELETE.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000001'; -- SUPER_ADMIN

select throws_ok(
  $$ delete from public.workera_attendance_events where external_employee_code = 'S6A-PROD-001' $$,
  '42501',
  null,
  'SUPER_ADMIN no puede eliminar físicamente un evento crudo de Workera (sin GRANT DELETE)'
);

reset role;
set local role service_role;

select throws_ok(
  $$ delete from public.workera_attendance_events where external_employee_code = 'S6A-PROD-001' $$,
  '42501',
  null,
  'service_role no puede eliminar físicamente un evento crudo (sin GRANT DELETE, ni siquiera para el propio pipeline de sync)'
);

-- ---------------------------------------------------------------------------
-- 14) Lectura amplia (is_corporate_user) para todos los roles corporativos
--     autenticados — mismo criterio que attendance_records.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '91000000-0000-0000-0000-000000000003'; -- SUPERVISOR_PRODUCTION

select lives_ok(
  $$ select * from public.workera_attendance_events $$,
  'SUPERVISOR_PRODUCTION puede leer workera_attendance_events (RLS de lectura amplia)'
);

-- ---------------------------------------------------------------------------
-- 15) anon no tiene ningún acceso.
reset role;
set local role anon;

select throws_ok(
  $$ select * from public.workera_attendance_events $$,
  '42501',
  null,
  'anon no tiene ningún privilegio sobre workera_attendance_events (revoke all confirmado)'
);

-- ---------------------------------------------------------------------------
-- 16) attendance_corrections (Gate D) sigue funcionando sin verse afectado
--     por la tabla nueva — ambos mecanismos coexisten sin interferir.
reset role;
select ok(
  has_table_privilege('authenticated', 'public.attendance_corrections', 'INSERT'),
  'attendance_corrections conserva su propio camino de escritura para authenticated, sin verse afectado por Fase 6A'
);

-- ---------------------------------------------------------------------------
-- 17) sync_runs.records_unchanged existe y respeta su check >= 0.
select has_column('public', 'sync_runs', 'records_unchanged',
  'sync_runs tiene la columna nueva records_unchanged (Fase 6A, extensión aditiva)');

set local role service_role;
select throws_ok(
  $$ update public.sync_runs set records_unchanged = -1 where id = '91000000-0000-0000-0000-00000000b001' $$,
  '23514',
  null,
  'records_unchanged no admite valores negativos (sync_runs_unchanged_chk)'
);

-- ---------------------------------------------------------------------------
-- 18) metadata de sync_run exitoso: status SUCCEEDED con conteos coherentes
--     es una fila válida (camino feliz).
select lives_ok(
  $$ update public.sync_runs
       set status = 'SUCCEEDED', finished_at = now(), records_read = 1, records_created = 1
       where id = '91000000-0000-0000-0000-00000000b001' $$,
  'sync_runs acepta metadata de un sync exitoso (status SUCCEEDED, conteos coherentes)'
);

-- ---------------------------------------------------------------------------
-- 19) metadata de sync_run fallido: status FAILED con error_summary poblado
--     es una fila válida (camino de error, no debe requerir workarounds).
select lives_ok(
  $$ update public.sync_runs
       set status = 'FAILED', finished_at = now(),
           error_summary = jsonb_build_object('reason', 'WORKERA_TIMEOUT_ERROR')
       where id = '91000000-0000-0000-0000-00000000b001' $$,
  'sync_runs acepta metadata de un sync fallido (status FAILED, error_summary poblado)'
);

select * from finish();
rollback;
