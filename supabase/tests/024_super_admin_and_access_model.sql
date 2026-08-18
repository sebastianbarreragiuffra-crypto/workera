-- pgTAP Fase 5D: SUPER_ADMIN — existencia del rol, lectura/escritura
-- administrativa amplia, prevención de escalamiento de privilegios,
-- inmutabilidad de attendance_records/audit_log incluso para SUPER_ADMIN,
-- protección del último SUPER_ADMIN activo, scoping de supervisores
-- preservado, y acceso anónimo denegado.
create extension if not exists pgtap;

begin;
select plan(39);

-- ---------------------------------------------------------------------------
-- 1) SUPER_ADMIN role exists
select ok(
  'SUPER_ADMIN' = any(enum_range(null::public.app_role)::text[]),
  'app_role incluye SUPER_ADMIN'
);
select is(
  (select array_agg(e::text order by e::text) from unnest(enum_range(null::public.app_role)) e),
  array['ADMIN_RRHH', 'SUPER_ADMIN', 'SUPERVISOR_INSTALLATION', 'SUPERVISOR_PRODUCTION'],
  'app_role contiene EXACTAMENTE los 4 tipos de rol confirmados (sin ADMIN/OWNER/ROOT)'
);

-- ---------------------------------------------------------------------------
-- Fixtures: 2 SUPER_ADMIN (para poder probar la protección del último sin
-- dejar el fixture set entero sin administrador), 1 ADMIN_RRHH, 1 supervisor
-- de cada grupo, 1 empleado por grupo.
insert into public.profiles (id, display_name, role) values
  ('90000000-0000-0000-0000-000000000001', 'Fixture Super Admin 1', 'SUPER_ADMIN'),
  ('90000000-0000-0000-0000-000000000002', 'Fixture Super Admin 2', 'SUPER_ADMIN'),
  ('90000000-0000-0000-0000-000000000003', 'Fixture RRHH', 'ADMIN_RRHH'),
  ('90000000-0000-0000-0000-000000000004', 'Fixture Supervisor Prod', 'SUPERVISOR_PRODUCTION'),
  ('90000000-0000-0000-0000-000000000005', 'Fixture Supervisor Install', 'SUPERVISOR_INSTALLATION'),
  ('90000000-0000-0000-0000-000000000006', 'Fixture Sin Rol', null);

insert into public.employees (id, external_workera_id, first_name, last_name, display_name, employee_group_id)
values
  ('90000000-0000-0000-0000-00000000a001', 'S5D-PROD-001', 'Fixture', 'ProdS5D', 'Fixture ProdS5D',
    (select id from public.employee_groups where code = 'PRODUCTION')),
  ('90000000-0000-0000-0000-00000000a002', 'S5D-INSTALL-001', 'Fixture', 'InstallS5D', 'Fixture InstallS5D',
    (select id from public.employee_groups where code = 'INSTALLATION'));

-- ---------------------------------------------------------------------------
-- 2) SUPER_ADMIN full read: empleados, asistencia cruda, decisiones,
--    bonos, auditoría, períodos.
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';

select lives_ok(
  $$ select * from public.employees $$,
  'SUPER_ADMIN puede leer employees'
);
select lives_ok(
  $$ select * from public.attendance_records $$,
  'SUPER_ADMIN puede leer attendance_records (crudo Workera)'
);
select lives_ok(
  $$ select * from public.overtime_decisions $$,
  'SUPER_ADMIN puede leer overtime_decisions'
);
select lives_ok(
  $$ select * from public.employee_daily_bonuses $$,
  'SUPER_ADMIN puede leer employee_daily_bonuses'
);
select lives_ok(
  $$ select * from public.audit_log $$,
  'SUPER_ADMIN puede leer audit_log'
);
select lives_ok(
  $$ select * from public.reporting_periods $$,
  'SUPER_ADMIN puede leer reporting_periods'
);

-- 3) SUPER_ADMIN administrative write: catálogo de política, empleados,
--    apertura de período.
select lives_ok(
  format(
    $$ insert into public.work_schedules (name) values ('Fixture horario SUPER_ADMIN %s') $$,
    extract(epoch from now())::text
  ),
  'SUPER_ADMIN puede escribir en work_schedules (tabla de política administrativa)'
);
select lives_ok(
  $$ update public.employees set display_name = 'Fixture ProdS5D (editado)'
       where id = '90000000-0000-0000-0000-00000000a001' $$,
  'SUPER_ADMIN puede editar employees'
);
select lives_ok(
  $$ insert into public.reporting_periods (period_start, period_end, status)
       values (date '2027-01-01', date '2027-01-31', 'OPEN') $$,
  'SUPER_ADMIN puede abrir un reporting_period'
);
reset role;

-- ---------------------------------------------------------------------------
-- 4) Workera source (attendance_records) permanece inmutable incluso para
--    SUPER_ADMIN: cero privilegio de escritura a nivel de tabla.
select is(
  has_table_privilege('authenticated', 'public.attendance_records', 'INSERT'),
  false,
  'Workera inmutable: authenticated (ningún rol, incluido SUPER_ADMIN) tiene INSERT sobre attendance_records'
);
select is(
  has_table_privilege('authenticated', 'public.attendance_records', 'UPDATE'),
  false,
  'Workera inmutable: authenticated no tiene UPDATE sobre attendance_records'
);
select is(
  has_table_privilege('authenticated', 'public.attendance_records', 'DELETE'),
  false,
  'Workera inmutable: authenticated no tiene DELETE sobre attendance_records'
);

-- 5) audit_log permanece inmutable incluso para SUPER_ADMIN.
select is(
  has_table_privilege('authenticated', 'public.audit_log', 'UPDATE'),
  false,
  'audit_log inmutable: authenticated no tiene UPDATE (ni siquiera SUPER_ADMIN)'
);
select is(
  has_table_privilege('authenticated', 'public.audit_log', 'DELETE'),
  false,
  'audit_log inmutable: authenticated no tiene DELETE (ni siquiera SUPER_ADMIN)'
);

set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';
select throws_ok(
  $$ update public.audit_log set action = 'TAMPERED' where true $$,
  '42501',
  null,
  'SUPER_ADMIN: intento de UPDATE sobre audit_log es rechazado a nivel de privilegio de tabla'
);
reset role;

-- ---------------------------------------------------------------------------
-- 6) Prevención de escalamiento de privilegios (PASO 11 del encargo)

-- SUPERVISOR_PRODUCTION -> intenta convertirse SUPER_ADMIN -> DENIED
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000004';
select lives_ok(
  $$ update public.profiles set role = 'SUPER_ADMIN'
       where id = '90000000-0000-0000-0000-000000000004' $$,
  'el UPDATE no truena (0 filas afectadas por RLS)'
);
reset role;
select is(
  (select role::text from public.profiles where id = '90000000-0000-0000-0000-000000000004'),
  'SUPERVISOR_PRODUCTION',
  'SUPERVISOR_PRODUCTION no logra escalar a SUPER_ADMIN'
);

-- SUPERVISOR_INSTALLATION -> intenta convertirse SUPER_ADMIN -> DENIED
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000005';
select lives_ok(
  $$ update public.profiles set role = 'SUPER_ADMIN'
       where id = '90000000-0000-0000-0000-000000000005' $$,
  'el UPDATE no truena (0 filas afectadas por RLS)'
);
reset role;
select is(
  (select role::text from public.profiles where id = '90000000-0000-0000-0000-000000000005'),
  'SUPERVISOR_INSTALLATION',
  'SUPERVISOR_INSTALLATION no logra escalar a SUPER_ADMIN'
);

-- SUPERVISOR intenta cambiar el rol de OTRO usuario -> DENIED
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000004';
select lives_ok(
  $$ update public.profiles set role = 'SUPERVISOR_INSTALLATION'
       where id = '90000000-0000-0000-0000-000000000006' $$,
  'el UPDATE no truena (0 filas afectadas por RLS)'
);
reset role;
select is(
  (select role from public.profiles where id = '90000000-0000-0000-0000-000000000006'),
  null,
  'SUPERVISOR_PRODUCTION no logra cambiar el rol de otro usuario'
);

-- ADMIN_RRHH -> intenta convertirse SUPER_ADMIN -> DENIED
--
-- Nota sobre la forma de esta aserción, distinta de los 2 casos de
-- supervisor de arriba: para un supervisor, la cláusula USING ya excluye la
-- fila por completo (is_privileged_admin() es falso para él) -> 0 filas
-- afectadas, sin excepción. Para ADMIN_RRHH, en cambio, USING SÍ deja pasar
-- su propia fila (is_admin_rrhh() es verdadero y su rol actual no es
-- SUPER_ADMIN) — es el WITH CHECK el que evalúa el valor NUEVO ('SUPER_ADMIN')
-- y lo rechaza, lo que en Postgres se manifiesta como una excepción real
-- (42501 "new row violates row-level security policy"), no como un UPDATE
-- silencioso de 0 filas. Ambos casos bloquean el escalamiento igual de
-- efectivamente; solo difiere el mecanismo (USING vs. WITH CHECK).
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000003';
select throws_ok(
  $$ update public.profiles set role = 'SUPER_ADMIN'
       where id = '90000000-0000-0000-0000-000000000003' $$,
  '42501',
  null,
  'ADMIN_RRHH no logra escalar a SUPER_ADMIN (WITH CHECK rechaza el nuevo valor)'
);
reset role;
select is(
  (select role::text from public.profiles where id = '90000000-0000-0000-0000-000000000003'),
  'ADMIN_RRHH',
  'ADMIN_RRHH permanece ADMIN_RRHH tras el intento rechazado'
);

-- ADMIN_RRHH -> intenta modificar (desactivar) al SUPER_ADMIN -> DENIED
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000003';
select lives_ok(
  $$ update public.profiles set active = false
       where id = '90000000-0000-0000-0000-000000000001' $$,
  'el UPDATE no truena (0 filas afectadas por RLS)'
);
reset role;
select is(
  (select active from public.profiles where id = '90000000-0000-0000-0000-000000000001'),
  true,
  'ADMIN_RRHH no logra desactivar la cuenta SUPER_ADMIN'
);

-- ---------------------------------------------------------------------------
-- 7) SUPER_ADMIN puede asignar roles permitidos (control positivo).
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';
select lives_ok(
  format(
    $$ update public.profiles set role = 'ADMIN_RRHH' where id = %L $$,
    '90000000-0000-0000-0000-000000000006'
  ),
  'SUPER_ADMIN puede crear/asignar ADMIN_RRHH a un usuario sin rol'
);
reset role;
select is(
  (select role::text from public.profiles where id = '90000000-0000-0000-0000-000000000006'),
  'ADMIN_RRHH',
  'SUPER_ADMIN: la asignación de rol ADMIN_RRHH se aplicó'
);

set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';
select lives_ok(
  format(
    $$ update public.profiles set role = 'SUPERVISOR_PRODUCTION' where id = %L $$,
    '90000000-0000-0000-0000-000000000006'
  ),
  'SUPER_ADMIN puede crear/asignar un supervisor'
);
reset role;

-- ---------------------------------------------------------------------------
-- 8) Protección del último SUPER_ADMIN (PASO 12 del encargo).

-- Con 2 SUPER_ADMIN activos, degradar UNO de ellos es permitido.
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';
select lives_ok(
  format(
    $$ update public.profiles set role = 'ADMIN_RRHH' where id = %L $$,
    '90000000-0000-0000-0000-000000000002'
  ),
  'con 2 SUPER_ADMIN activos, degradar uno de ellos es permitido'
);
reset role;
select is(
  (select role::text from public.profiles where id = '90000000-0000-0000-0000-000000000002'),
  'ADMIN_RRHH',
  'el segundo SUPER_ADMIN quedó degradado correctamente'
);

-- Ahora solo queda 1 SUPER_ADMIN activo (id ...0001). Intentar degradarlo
-- (incluso por sí mismo) debe ser rechazado explícitamente.
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000001';
select throws_ok(
  $$ update public.profiles set role = 'ADMIN_RRHH'
       where id = '90000000-0000-0000-0000-000000000001' $$,
  'P0001',
  null,
  'degradar al ÚLTIMO SUPER_ADMIN activo es rechazado explícitamente (no queda ninguno)'
);
select throws_ok(
  $$ update public.profiles set active = false
       where id = '90000000-0000-0000-0000-000000000001' $$,
  'P0001',
  null,
  'desactivar al ÚLTIMO SUPER_ADMIN activo es rechazado explícitamente'
);
reset role;
select is(
  (select role::text from public.profiles where id = '90000000-0000-0000-0000-000000000001'),
  'SUPER_ADMIN',
  'el último SUPER_ADMIN permanece SUPER_ADMIN tras el intento rechazado'
);
select is(
  (select active from public.profiles where id = '90000000-0000-0000-0000-000000000001'),
  true,
  'el último SUPER_ADMIN permanece activo tras el intento rechazado'
);

-- ---------------------------------------------------------------------------
-- 9) Scoping de supervisores preservado (no relajado por SUPER_ADMIN):
--    SUPERVISOR_PRODUCTION sigue sin poder operar sobre INSTALLATION.
insert into public.attendance_records
  (employee_id, work_date, actual_clock_in, actual_clock_out, source_hash, source_version, is_current)
values (
  '90000000-0000-0000-0000-00000000a002', date '2027-02-01',
  timestamptz '2027-02-01 08:00-03', timestamptz '2027-02-01 16:00-03',
  'hash-s5d-scope', 1, true
);
insert into public.overtime_records
  (employee_id, work_date, attendance_record_id, overtime_type_id, candidate_minutes, overtime_policy_id)
values (
  '90000000-0000-0000-0000-00000000a002', date '2027-02-01',
  (select id from public.attendance_records where source_hash = 'hash-s5d-scope'),
  (select id from public.overtime_types where code = 'OVERTIME_50'),
  60,
  (select op.id from public.overtime_policies op join public.employee_groups eg on eg.id = op.employee_group_id
     where eg.code = 'INSTALLATION' and op.day_of_week = extract(dow from date '2027-02-01')::int)
);
set local role authenticated;
set local request.jwt.claim.sub = '90000000-0000-0000-0000-000000000004'; -- SUPERVISOR_PRODUCTION
select throws_ok(
  format(
    $$ insert into public.overtime_decisions
         (overtime_record_id, approved_minutes, rejected_minutes, decision_status, decided_by)
       values (%L, 60, 0, 'FULLY_APPROVED', %L) $$,
    (select id from public.overtime_records where employee_id = '90000000-0000-0000-0000-00000000a002'),
    '90000000-0000-0000-0000-000000000004'
  ),
  '42501',
  null,
  'SUPERVISOR_PRODUCTION sigue sin poder aprobar horas extra de INSTALLATION (scoping preservado tras Fase 5D)'
);
reset role;

-- ---------------------------------------------------------------------------
-- 10) anonymous access denied.
set local role anon;
select throws_ok($$ select 1 from public.profiles $$, '42501', null, 'anon: SELECT profiles es denegado');
select throws_ok($$ select 1 from public.employees $$, '42501', null, 'anon: SELECT employees es denegado');
reset role;

select * from finish();
rollback;
