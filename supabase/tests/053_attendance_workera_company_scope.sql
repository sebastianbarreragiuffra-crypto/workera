-- pgTAP MT-3B: aislamiento tenant de asistencia, Workera y motor de reglas.
create extension if not exists pgtap;

begin;
select plan(26);

select has_column('public', 'sync_runs', 'company_id', 'sync_runs declara tenant');
select has_column('public', 'attendance_records', 'company_id', 'attendance_records declara tenant');
select has_column('public', 'attendance_status_records', 'company_id', 'attendance_status_records declara tenant');
select has_column('public', 'attendance_corrections', 'company_id', 'attendance_corrections declara tenant');
select has_column('public', 'workera_attendance_events', 'company_id', 'eventos Workera declaran tenant');
select has_column('public', 'rule_engine_runs', 'company_id', 'rule_engine_runs declara tenant');

select col_not_null('public', 'sync_runs', 'company_id', 'sync_runs.company_id es obligatorio');
select col_not_null('public', 'attendance_records', 'company_id', 'attendance_records.company_id es obligatorio');
select col_not_null('public', 'attendance_status_records', 'company_id', 'attendance_status_records.company_id es obligatorio');
select col_not_null('public', 'attendance_corrections', 'company_id', 'attendance_corrections.company_id es obligatorio');
select col_not_null('public', 'workera_attendance_events', 'company_id', 'eventos Workera exigen company_id');
select col_not_null('public', 'rule_engine_runs', 'company_id', 'rule_engine_runs.company_id es obligatorio');

select is(
  (select column_default from information_schema.columns
   where table_schema = 'public' and table_name = 'sync_runs' and column_name = 'company_id'),
  null,
  'sync_runs no tiene tenant por defecto implícito'
);
select is(
  (select column_default from information_schema.columns
   where table_schema = 'public' and table_name = 'rule_engine_runs' and column_name = 'company_id'),
  null,
  'rule_engine_runs no tiene tenant por defecto implícito'
);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values (
  '95000000-0000-0000-0000-000000000002',
  'Attendance Tenant B', 'Attendance Tenant B SpA', 'attendance-tenant-b',
  true, 'ONBOARDING', false
);

select lives_ok(
  $$insert into public.sync_runs (
      company_id, status, target_period_start, target_period_end
    ) values
      ('0a4c0000-0000-0000-0000-000000000001', 'RUNNING', '2098-01-01', '2098-01-01'),
      ('95000000-0000-0000-0000-000000000002', 'RUNNING', '2098-01-01', '2098-01-01')$$,
  'dos empresas pueden mantener un lock RUNNING para el mismo rango'
);

select throws_ok(
  $$insert into public.sync_runs (
      company_id, status, target_period_start, target_period_end
    ) values (
      '0a4c0000-0000-0000-0000-000000000001', 'RUNNING', '2098-01-01', '2098-01-01'
    )$$,
  '23505', null,
  'la misma empresa no puede duplicar un lock RUNNING para el mismo rango'
);

update public.sync_runs
set status = 'SUCCEEDED', finished_at = now()
where target_period_start = '2098-01-01';

insert into public.sync_runs (
  id, company_id, status, target_period_start, target_period_end, started_at
) values
  (
    '95000000-0000-0000-0000-000000000101',
    '0a4c0000-0000-0000-0000-000000000001',
    'RUNNING', '2098-01-02', '2098-01-02', now() - interval '20 minutes'
  ),
  (
    '95000000-0000-0000-0000-000000000102',
    '95000000-0000-0000-0000-000000000002',
    'RUNNING', '2098-01-02', '2098-01-02', now() - interval '20 minutes'
  );

select is(
  public.reclaim_stale_workera_sync_runs(
    '0a4c0000-0000-0000-0000-000000000001', 900
  ),
  1,
  'reclaim Workera solo recupera locks del tenant solicitado'
);
select is(
  (select status from public.sync_runs where id = '95000000-0000-0000-0000-000000000102'),
  'RUNNING',
  'reclaim de ARCOTEX no modifica el lock abandonado de otra empresa'
);

select ok(
  exists (
    select 1
    from pg_constraint
    where conrelid = 'public.workera_attendance_events'::regclass
      and conname = 'workera_attendance_events_company_employee_fkey'
      and contype = 'f'
  ),
  'eventos Workera tienen FK compuesta que impide cruzar empleado y empresa'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.reclaim_stale_workera_sync_runs(uuid,integer)',
    'EXECUTE'
  ),
  'service_role puede recuperar locks de un tenant explícito'
);

-- ---------------------------------------------------------------------------
-- RLS desde una sesión autenticada.
--
-- Todo lo anterior corre como superusuario, que no pasa por RLS: comprueba
-- columnas, claves, índices y grants, pero no las policies que esta migración
-- reescribe, que son donde vive el aislamiento en tiempo de lectura. Sin este
-- bloque, un `using` mal escrito pasaba el suite entero.
--
-- Las filas de la empresa B se siembran con `session_replication_role =
-- replica`, igual que hace 052 para el proveedor cruzado: acá lo que se
-- ejercita es el filtro por company_id de las policies, no la integridad
-- referencial, que ya cubren las asserts de FK compuesta de más arriba.

insert into public.profiles (id, display_name, role, active) values
  ('95000000-0000-0000-0000-000000000101', 'Attendance User A', 'ADMIN_RRHH', true),
  ('95000000-0000-0000-0000-000000000103', 'Attendance Platform Only', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('95000000-0000-0000-0000-000000000103', 'ADMIN', true);

set local session_replication_role = replica;

insert into public.attendance_records (
  id, company_id, employee_id, work_date, source_hash
) values
  ('95000000-0000-0000-0000-000000000301', '0a4c0000-0000-0000-0000-000000000001',
   '95000000-0000-0000-0000-000000000201', '2098-02-01', 'hash-a'),
  ('95000000-0000-0000-0000-000000000302', '95000000-0000-0000-0000-000000000002',
   '95000000-0000-0000-0000-000000000202', '2098-02-01', 'hash-b');

-- Fechas y estado distintos de los locks de más arriba: el índice único de
-- concurrencia solo cubre las filas RUNNING.
insert into public.sync_runs (
  id, company_id, status, target_period_start, target_period_end
) values
  ('95000000-0000-0000-0000-000000000501', '0a4c0000-0000-0000-0000-000000000001',
   'SUCCEEDED', '2098-03-01', '2098-03-01'),
  ('95000000-0000-0000-0000-000000000502', '95000000-0000-0000-0000-000000000002',
   'SUCCEEDED', '2098-03-01', '2098-03-01');

insert into public.workera_attendance_events (
  id, company_id, employee_id, sync_run_id, external_employee_code, work_date,
  attendance_timestamp_raw, attendance_type_code, attendance_type_label,
  attendance_status, external_attendance_status
) values
  ('95000000-0000-0000-0000-000000000401', '0a4c0000-0000-0000-0000-000000000001',
   '95000000-0000-0000-0000-000000000201', '95000000-0000-0000-0000-000000000501',
   'EMP-A', '2098-02-01', '2098-02-01 08:00:00', 1, 'Entrada', 'OK', 'OK'),
  ('95000000-0000-0000-0000-000000000402', '95000000-0000-0000-0000-000000000002',
   '95000000-0000-0000-0000-000000000202', '95000000-0000-0000-0000-000000000502',
   'EMP-B', '2098-02-01', '2098-02-01 08:00:00', 1, 'Entrada', 'OK', 'OK');

set local session_replication_role = origin;

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000101';

select is(
  (select count(*)::integer from public.attendance_records
   where company_id = '95000000-0000-0000-0000-000000000002'),
  0,
  'un ADMIN_RRHH de ARCOTEX no ve ni una marcación de otra empresa'
);
select is(
  (select count(*)::integer from public.attendance_records
   where company_id = '0a4c0000-0000-0000-0000-000000000001'
     and id = '95000000-0000-0000-0000-000000000301'),
  1,
  'y sigue viendo las de la suya: la policy filtra, no bloquea'
);
select is(
  (select count(*)::integer from public.workera_attendance_events
   where company_id = '95000000-0000-0000-0000-000000000002'),
  0,
  'tampoco ve los eventos crudos de Workera de otra empresa'
);
select is(
  (select count(*)::integer from public.sync_runs
   where company_id = '95000000-0000-0000-0000-000000000002'),
  0,
  'ni las corridas de sincronizacion de otra empresa'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000103';
select is(
  (select count(*)::integer from public.attendance_records),
  0,
  'un ADMIN de plataforma sin membresia laboral no ve asistencia de nadie'
);
reset role;

update public.company_memberships
set active = false
where user_id = '95000000-0000-0000-0000-000000000101'
  and company_id = '0a4c0000-0000-0000-0000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000101';
select is(
  (select count(*)::integer from public.attendance_records),
  0,
  'desactivar la membresia revoca la asistencia de inmediato'
);
reset role;

select * from finish();
rollback;
