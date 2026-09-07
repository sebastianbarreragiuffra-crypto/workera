-- pgTAP: importación Excel tenant-aware, precedencia de fuentes,
-- precondiciones CAS e idempotencia observable.
create extension if not exists pgtap;

begin;
select plan(56);

select has_function(
  'public', 'apply_personnel_roster_import',
  array['uuid', 'jsonb', 'jsonb', 'jsonb', 'uuid'],
  'existe únicamente la firma tenant-aware del importador'
);

select ok(
  to_regprocedure('public.apply_personnel_roster_import(jsonb,jsonb,jsonb,uuid)') is null,
  'la firma legacy sin company_id fue eliminada'
);

select ok(
  (
    select pg_catalog.pg_get_function_result(p.oid) = 'jsonb'
    from pg_catalog.pg_proc p
    where p.oid = 'public.apply_personnel_roster_import(uuid,jsonb,jsonb,jsonb,uuid)'::regprocedure
  ),
  'el RPC devuelve conteos JSON confirmados por la base'
);

select ok(
  (
    select not p.prosecdef and p.provolatile = 'v'
    from pg_catalog.pg_proc p
    where p.oid = 'public.apply_personnel_roster_import(uuid,jsonb,jsonb,jsonb,uuid)'::regprocedure
  ),
  'el RPC es VOLATILE y SECURITY INVOKER'
);

select ok(
  has_function_privilege('authenticated', 'public.apply_personnel_roster_import(uuid,jsonb,jsonb,jsonb,uuid)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.apply_personnel_roster_import(uuid,jsonb,jsonb,jsonb,uuid)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.apply_personnel_roster_import(uuid,jsonb,jsonb,jsonb,uuid)', 'EXECUTE'),
  'sólo authenticated puede ejecutar la frontera'
);

select ok(
  (
    select position(
      'pg_advisory_xact_lock(hashtextextended(''employee_roster:'' || p_company_id::text, 0))'
      in p.prosrc
    ) > 0
    from pg_catalog.pg_proc p
    where p.oid = 'public.apply_personnel_roster_import(uuid,jsonb,jsonb,jsonb,uuid)'::regprocedure
  ),
  'usa exactamente el lock transaccional compartido por empresa'
);

select ok(
  (
    select p.prosrc like '%public.has_company_app_role(p_company_id, ''ADMIN_RRHH'')%'
      and p.prosrc like '%public.has_company_app_role(p_company_id, ''SUPER_ADMIN'')%'
      and p.prosrc not like '%is_privileged_admin%'
      and p.prosrc not like '%is_active_company_member%'
    from pg_catalog.pg_proc p
    where p.oid = 'public.apply_personnel_roster_import(uuid,jsonb,jsonb,jsonb,uuid)'::regprocedure
  ),
  'la autorización usa exclusivamente el rol administrativo del tenant'
);

select ok(
  to_regclass('public.employees_rut_key') is null
  and exists (
    select 1
    from pg_catalog.pg_class idx
    join pg_catalog.pg_index i on i.indexrelid = idx.oid
    where idx.oid = to_regclass('public.employees_company_id_rut_key')
      and i.indisunique
      and i.indpred is not null
      and pg_catalog.pg_get_indexdef(i.indexrelid) like '%(company_id, rut)%'
  ),
  'RUT es único por empresa y no globalmente'
);

-- Dos tenants operativos sólo dentro de esta transacción de prueba.
alter table public.companies drop constraint companies_workspace_mt3a_gate_chk;

insert into public.companies (id, name, slug, active, status, workspace_enabled) values
  ('b1200000-0000-4000-8000-000000000001', 'PGTAP ROSTER A', 'pgtap-roster-a-112', true, 'ACTIVE', true),
  ('b1200000-0000-4000-8000-000000000002', 'PGTAP ROSTER B', 'pgtap-roster-b-112', true, 'ACTIVE', true);

insert into public.profiles (id, display_name, role, active) values
  ('b1200000-0000-4000-8000-000000000101', 'PGTAP ADMIN A', 'ADMIN_RRHH', true),
  ('b1200000-0000-4000-8000-000000000102', 'PGTAP ADMIN SIN MEMBRESIA', 'ADMIN_RRHH', true),
  ('b1200000-0000-4000-8000-000000000104', 'PGTAP ADMIN TENANT PURO', null, true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('b1200000-0000-4000-8000-000000000111', 'b1200000-0000-4000-8000-000000000101', 'b1200000-0000-4000-8000-000000000001', 'ADMIN_RRHH', true),
  ('b1200000-0000-4000-8000-000000000112', 'b1200000-0000-4000-8000-000000000101', 'b1200000-0000-4000-8000-000000000002', 'SUPERVISOR_PRODUCTION', true),
  ('b1200000-0000-4000-8000-000000000114', 'b1200000-0000-4000-8000-000000000104', 'b1200000-0000-4000-8000-000000000002', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr
  on cr.company_id = cm.company_id and cr.base_role = cm.role
where cm.id in (
  'b1200000-0000-4000-8000-000000000111',
  'b1200000-0000-4000-8000-000000000112',
  'b1200000-0000-4000-8000-000000000114'
);

insert into public.employee_groups (id, company_id, code, name, active) values
  ('b1200000-0000-4000-8000-000000000201', 'b1200000-0000-4000-8000-000000000001', 'PGTAP_ROSTER_A_112', 'PGTAP ROSTER A', true),
  ('b1200000-0000-4000-8000-000000000202', 'b1200000-0000-4000-8000-000000000002', 'PGTAP_ROSTER_B_112', 'PGTAP ROSTER B', true);

insert into public.employees (
  id, company_id, external_workera_id, rut,
  first_name, last_name, display_name,
  employee_group_id, hire_date, source, active, created_at, updated_at
) values
  ('b1200000-0000-4000-8000-000000000301', 'b1200000-0000-4000-8000-000000000001', 'EXCEL-71200002-2', '71200002-2', 'EXCEL', 'INACTIVO', 'EXCEL INACTIVO', 'b1200000-0000-4000-8000-000000000201', null, 'excel_roster', false, '2026-09-07 10:00:00+00', '2026-09-07 10:00:00+00'),
  ('b1200000-0000-4000-8000-000000000302', 'b1200000-0000-4000-8000-000000000001', 'WORKERA-PGTAP-112-INACTIVO', '71200003-3', 'WORKERA', 'INACTIVO', 'WORKERA INACTIVO', 'b1200000-0000-4000-8000-000000000201', null, 'workera', false, '2026-09-07 10:00:00+00', '2026-09-07 10:00:00+00'),
  ('b1200000-0000-4000-8000-000000000303', 'b1200000-0000-4000-8000-000000000001', 'LOCAL-PROVISIONAL:PGTAP-112', '71200004-4', 'LOCAL', 'PROVISIONAL', 'LOCAL PROVISIONAL', 'b1200000-0000-4000-8000-000000000201', null, 'local_provisional', false, '2026-09-07 10:00:00+00', '2026-09-07 10:00:00+00'),
  ('b1200000-0000-4000-8000-000000000304', 'b1200000-0000-4000-8000-000000000001', 'EXCEL-71200005-5', '71200005-5', 'EXCEL', 'ACTIVO', 'EXCEL ACTIVO', 'b1200000-0000-4000-8000-000000000201', null, 'excel_roster', true, '2026-09-07 10:00:00+00', '2026-09-07 10:00:00+00'),
  ('b1200000-0000-4000-8000-000000000305', 'b1200000-0000-4000-8000-000000000002', 'EXCEL-71200006-6', '71200006-6', 'OTRA', 'EMPRESA', 'OTRA EMPRESA', 'b1200000-0000-4000-8000-000000000202', null, 'excel_roster', true, '2026-09-07 10:00:00+00', '2026-09-07 10:00:00+00'),
  ('b1200000-0000-4000-8000-000000000306', 'b1200000-0000-4000-8000-000000000001', 'WORKERA-PGTAP-112-ACTIVO', '71200007-7', 'WORKERA', 'ACTIVO', 'WORKERA ACTIVO', 'b1200000-0000-4000-8000-000000000201', null, 'workera', true, '2026-09-07 10:00:00+00', '2026-09-07 10:00:00+00'),
  ('b1200000-0000-4000-8000-000000000307', 'b1200000-0000-4000-8000-000000000001', 'WORKERA-PGTAP-112-STALE', '71200008-8', 'WORKERA', 'STALE', 'WORKERA STALE', 'b1200000-0000-4000-8000-000000000201', null, 'workera', false, '2026-09-07 10:00:00+00', '2026-09-07 10:00:00+00'),
  ('b1200000-0000-4000-8000-000000000308', 'b1200000-0000-4000-8000-000000000001', 'EXCEL-71200009-9', '71200009-9', 'EXCEL', 'STALE', 'EXCEL STALE', 'b1200000-0000-4000-8000-000000000201', null, 'excel_roster', true, '2026-09-07 10:00:00+00', '2026-09-07 10:00:00+00'),
  ('b1200000-0000-4000-8000-000000000311', 'b1200000-0000-4000-8000-000000000001', 'LOCAL-PROVISIONAL:PGTAP-112-REACTIVATE', '71200011-1', 'LOCAL', 'INACTIVO', 'LOCAL INACTIVO', 'b1200000-0000-4000-8000-000000000201', null, 'local_provisional', false, '2026-09-07 10:00:00+00', '2026-09-07 10:00:00+00');

create temporary table roster_112_observed (
  observation text primary key,
  tuple_1 tid,
  tuple_2 tid,
  tuple_3 tid
);

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';

select throws_ok(
  $$select public.apply_personnel_roster_import(null, '[]', '[]', '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '22023', null, 'company_id es obligatorio'
);

select throws_ok(
  $$select public.apply_personnel_roster_import('b1200000-0000-4000-8000-000000000001', '{}', '[]', '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '22023', null, 'los tres bloques deben ser arrays'
);

select throws_ok(
  $$select public.apply_personnel_roster_import('b1200000-0000-4000-8000-000000000001', '[]', '[]', '[]', 'b1200000-0000-4000-8000-000000000102')$$,
  '42501', null, 'p_actor_id no puede suplantar otra identidad'
);

set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000102';
select throws_ok(
  $$select public.apply_personnel_roster_import('b1200000-0000-4000-8000-000000000001', '[]', '[]', '[]', 'b1200000-0000-4000-8000-000000000102')$$,
  '42501', null, 'un admin legacy sin membresía activa no puede importar'
);

set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import('b1200000-0000-4000-8000-000000000002', '[]', '[]', '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '42501', null, 'un admin de otro tenant con rol bajo en destino no hereda privilegios'
);

select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]',
      '[{"id":"b1200000-0000-4000-8000-000000000301","employee_group_id":"","hire_date":""}]',
      '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '22023', null, 'cada update exige prior_rut/source/active/updated_at'
);

select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]', '[]',
      '["b1200000-0000-4000-8000-000000000304"]',
      'b1200000-0000-4000-8000-000000000101')$$,
  '22023', null, 'cada desactivación exige un objeto con prior_*'
);

select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]',
      '[{"id":"b1200000-0000-4000-8000-000000000301","employee_group_id":"","hire_date":"","prior_rut":"71200002-2","prior_source":"excel_roster","prior_active":false,"prior_updated_at":"no-es-fecha"}]',
      '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '22023', null, 'timestamp inválido de update se normaliza como input inválido'
);

select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]', '[]',
      '[{"id":"b1200000-0000-4000-8000-000000000304","prior_rut":"71200005-5","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"no-es-fecha"}]',
      'b1200000-0000-4000-8000-000000000101')$$,
  '22023', null, 'timestamp inválido de deactivación se normaliza como input inválido'
);

select is(
  public.apply_personnel_roster_import('b1200000-0000-4000-8000-000000000001', '[]', '[]', '[]', 'b1200000-0000-4000-8000-000000000101'),
  '{"inserted_count":0,"updated_count":0,"reactivated_count":0,"deactivated_count":0}'::jsonb,
  'un roster vacío devuelve conteos cero'
);

-- Identidad por tenant e idempotencia de altas.
select is(
  public.apply_personnel_roster_import(
    'b1200000-0000-4000-8000-000000000001',
    '[{"rut":"79999999-9","first_name":"MISMA","last_name":"PERSONA","display_name":"MISMA PERSONA","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":""}]',
    '[]', '[]', 'b1200000-0000-4000-8000-000000000101'),
  '{"inserted_count":1,"updated_count":0,"reactivated_count":0,"deactivated_count":0}'::jsonb,
  'la primera empresa inserta el RUT con conteo uno'
);

reset role;
insert into roster_112_observed (observation, tuple_1)
select 'insert-a', ctid from public.employees
where company_id = 'b1200000-0000-4000-8000-000000000001' and rut = '79999999-9';

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select is(
  public.apply_personnel_roster_import(
    'b1200000-0000-4000-8000-000000000001',
    '[{"rut":"79999999-9","first_name":"MISMA","last_name":"PERSONA","display_name":"MISMA PERSONA","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":""}]',
    '[]', '[]', 'b1200000-0000-4000-8000-000000000101'),
  '{"inserted_count":0,"updated_count":0,"reactivated_count":0,"deactivated_count":0}'::jsonb,
  'retry exacto del insert es no-op con conteos cero'
);

reset role;
select is(
  (select ctid from public.employees where company_id = 'b1200000-0000-4000-8000-000000000001' and rut = '79999999-9'),
  (select tuple_1 from roster_112_observed where observation = 'insert-a'),
  'retry de alta no crea una nueva versión física'
);

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000104';
select ok(
  not public.is_corporate_user()
  and public.has_company_app_role('b1200000-0000-4000-8000-000000000002', 'ADMIN_RRHH'),
  'el administrador puramente tenant no depende de profiles.role'
);

select is(
  public.apply_personnel_roster_import(
    'b1200000-0000-4000-8000-000000000002',
    '[{"rut":"79999999-9","first_name":"MISMA","last_name":"PERSONA","display_name":"MISMA PERSONA","employee_group_id":"b1200000-0000-4000-8000-000000000202","hire_date":"","birth_month":"5","birth_day":"15"}]',
    '[]', '[]', 'b1200000-0000-4000-8000-000000000104'),
  '{"inserted_count":1,"updated_count":0,"reactivated_count":0,"deactivated_count":0}'::jsonb,
  'admin puramente tenant inserta con grupo y cumpleaños en su empresa'
);

reset role;
select is((select count(*) from public.employees where rut = '79999999-9'), 2::bigint,
  'UNIQUE(company_id,rut) permite el mismo RUT en dos empresas');
select ok(
  exists (
    select 1 from public.employee_birthdays eb
    join public.employees e on e.id = eb.employee_id
    where e.company_id = 'b1200000-0000-4000-8000-000000000002'
      and e.rut = '79999999-9' and eb.birth_month = 5 and eb.birth_day = 15
  ),
  'las policies permiten al admin tenant escribir cumpleaños sólo de su empresa'
);

-- Precedencia y retry de updates.
set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select is(
  public.apply_personnel_roster_import(
    'b1200000-0000-4000-8000-000000000001', '[]',
    '[
      {"id":"b1200000-0000-4000-8000-000000000301","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"","first_name":"EXCEL","last_name":"INACTIVO","display_name":"EXCEL INACTIVO","reactivate":"true","prior_rut":"71200002-2","prior_source":"excel_roster","prior_active":false,"prior_updated_at":"2026-09-07T10:00:00+00:00"},
      {"id":"b1200000-0000-4000-8000-000000000302","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"2026-01-02","prior_rut":"71200003-3","prior_source":"workera","prior_active":false,"prior_updated_at":"2026-09-07T10:00:00+00:00"},
      {"id":"b1200000-0000-4000-8000-000000000303","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"2026-01-03","prior_rut":"71200004-4","prior_source":"local_provisional","prior_active":false,"prior_updated_at":"2026-09-07T10:00:00+00:00"}
    ]', '[]', 'b1200000-0000-4000-8000-000000000101'),
  '{"inserted_count":0,"updated_count":2,"reactivated_count":1,"deactivated_count":0}'::jsonb,
  'plan mixto devuelve conteos precisos'
);

reset role;
select is((select active from public.employees where id = 'b1200000-0000-4000-8000-000000000301'), true, 'Excel explícito sí se reactiva');
select is((select active from public.employees where id = 'b1200000-0000-4000-8000-000000000302'), false, 'Workera conserva active=false');
select is((select active from public.employees where id = 'b1200000-0000-4000-8000-000000000303'), false, 'provisional conserva active=false');
select ok(
  (select hire_date = date '2026-01-02' from public.employees where id = 'b1200000-0000-4000-8000-000000000302')
  and (select hire_date = date '2026-01-03' from public.employees where id = 'b1200000-0000-4000-8000-000000000303'),
  'fuentes superiores reciben metadata sin reactivarse'
);

insert into roster_112_observed (observation, tuple_1, tuple_2, tuple_3)
select 'mixed',
  (select ctid from public.employees where id = 'b1200000-0000-4000-8000-000000000301'),
  (select ctid from public.employees where id = 'b1200000-0000-4000-8000-000000000302'),
  (select ctid from public.employees where id = 'b1200000-0000-4000-8000-000000000303');

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select is(
  public.apply_personnel_roster_import(
    'b1200000-0000-4000-8000-000000000001', '[]',
    '[
      {"id":"b1200000-0000-4000-8000-000000000301","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"","first_name":"EXCEL","last_name":"INACTIVO","display_name":"EXCEL INACTIVO","reactivate":"true","prior_rut":"71200002-2","prior_source":"excel_roster","prior_active":false,"prior_updated_at":"2026-09-07T10:00:00+00:00"},
      {"id":"b1200000-0000-4000-8000-000000000302","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"2026-01-02","prior_rut":"71200003-3","prior_source":"workera","prior_active":false,"prior_updated_at":"2026-09-07T10:00:00+00:00"},
      {"id":"b1200000-0000-4000-8000-000000000303","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"2026-01-03","prior_rut":"71200004-4","prior_source":"local_provisional","prior_active":false,"prior_updated_at":"2026-09-07T10:00:00+00:00"}
    ]', '[]', 'b1200000-0000-4000-8000-000000000101'),
  '{"inserted_count":0,"updated_count":0,"reactivated_count":0,"deactivated_count":0}'::jsonb,
  'retry exacto del update aplicado devuelve conteos cero'
);

reset role;
select ok(
  (
    select e1.ctid = o.tuple_1 and e2.ctid = o.tuple_2 and e3.ctid = o.tuple_3
    from roster_112_observed o
    join public.employees e1 on e1.id = 'b1200000-0000-4000-8000-000000000301'
    join public.employees e2 on e2.id = 'b1200000-0000-4000-8000-000000000302'
    join public.employees e3 on e3.id = 'b1200000-0000-4000-8000-000000000303'
    where o.observation = 'mixed'
  ),
  'retry exacto no muta físicamente ninguna fila'
);

-- La autoridad de fuente también rige la ruta idempotente.
set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]',
      '[{"id":"b1200000-0000-4000-8000-000000000306","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"","reactivate":"true","prior_rut":"71200007-7","prior_source":"workera","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]',
      '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '42501', null, 'Excel nunca acepta reactivar source=workera'
);
reset role;
select ok((select active and updated_at = '2026-09-07 10:00:00+00' from public.employees where id = 'b1200000-0000-4000-8000-000000000306'), 'intento Workera no muta');

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]',
      '[{"id":"b1200000-0000-4000-8000-000000000311","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"","reactivate":"true","prior_rut":"71200011-1","prior_source":"local_provisional","prior_active":false,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]',
      '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '42501', null, 'Excel nunca acepta reactivar source=local_provisional'
);
reset role;
select ok((select not active and updated_at = '2026-09-07 10:00:00+00' from public.employees where id = 'b1200000-0000-4000-8000-000000000311'), 'intento provisional no muta');

-- IDs cross-tenant abortan todo el lote.
set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]',
      '[
        {"id":"b1200000-0000-4000-8000-000000000304","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"2026-03-04","prior_rut":"71200005-5","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"},
        {"id":"b1200000-0000-4000-8000-000000000305","employee_group_id":"b1200000-0000-4000-8000-000000000202","hire_date":"2026-03-05","prior_rut":"71200006-6","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}
      ]', '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '40001', null, 'update con id de otro tenant falla stale'
);
reset role;
select ok((select hire_date is null and updated_at = '2026-09-07 10:00:00+00' from public.employees where id = 'b1200000-0000-4000-8000-000000000304'), 'update previo se revierte');

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]', '[]',
      '[
        {"id":"b1200000-0000-4000-8000-000000000304","prior_rut":"71200005-5","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"},
        {"id":"b1200000-0000-4000-8000-000000000305","prior_rut":"71200006-6","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}
      ]', 'b1200000-0000-4000-8000-000000000101')$$,
  '40001', null, 'deactivate con id de otro tenant falla stale'
);
reset role;
select ok((select active and updated_at = '2026-09-07 10:00:00+00' from public.employees where id = 'b1200000-0000-4000-8000-000000000304'), 'deactivate previo se revierte');

-- Desactivación idempotente.
set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select is(
  public.apply_personnel_roster_import(
    'b1200000-0000-4000-8000-000000000001', '[]', '[]',
    '[{"id":"b1200000-0000-4000-8000-000000000304","prior_rut":"71200005-5","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]',
    'b1200000-0000-4000-8000-000000000101'),
  '{"inserted_count":0,"updated_count":0,"reactivated_count":0,"deactivated_count":1}'::jsonb,
  'deactivate válido devuelve conteo uno'
);
reset role;
insert into roster_112_observed (observation, tuple_1)
select 'deactivate', ctid from public.employees where id = 'b1200000-0000-4000-8000-000000000304';
select is((select active from public.employees where id = 'b1200000-0000-4000-8000-000000000304'), false, 'deactivate deja inactive');

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select is(
  public.apply_personnel_roster_import(
    'b1200000-0000-4000-8000-000000000001', '[]', '[]',
    '[{"id":"b1200000-0000-4000-8000-000000000304","prior_rut":"71200005-5","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]',
    'b1200000-0000-4000-8000-000000000101'),
  '{"inserted_count":0,"updated_count":0,"reactivated_count":0,"deactivated_count":0}'::jsonb,
  'retry exacto de deactivate devuelve conteos cero'
);
reset role;
select is(
  (select ctid from public.employees where id = 'b1200000-0000-4000-8000-000000000304'),
  (select tuple_1 from roster_112_observed where observation = 'deactivate'),
  'retry de deactivate no muta físicamente la fila'
);

-- Stale por active en update: revierte un update válido anterior.
update public.employees set active = true
where id = 'b1200000-0000-4000-8000-000000000307';

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]',
      '[
        {"id":"b1200000-0000-4000-8000-000000000306","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"2026-05-06","prior_rut":"71200007-7","prior_source":"workera","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"},
        {"id":"b1200000-0000-4000-8000-000000000307","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"2026-05-07","prior_rut":"71200008-8","prior_source":"workera","prior_active":false,"prior_updated_at":"2026-09-07T10:00:00+00:00"}
      ]', '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '40001', null, 'update con active cambiado falla stale'
);
reset role;
select ok((select hire_date is null and updated_at = '2026-09-07 10:00:00+00' from public.employees where id = 'b1200000-0000-4000-8000-000000000306'), 'update válido anterior se revierte');
select ok((select active and hire_date is null and updated_at <> '2026-09-07 10:00:00+00' from public.employees where id = 'b1200000-0000-4000-8000-000000000307'), 'estado concurrente se conserva');

-- Stale por updated_at en deactivate: revierte el bloque update anterior.
update public.employees set display_name = display_name
where id = 'b1200000-0000-4000-8000-000000000308';

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]',
      '[{"id":"b1200000-0000-4000-8000-000000000306","employee_group_id":"b1200000-0000-4000-8000-000000000201","hire_date":"2026-06-06","prior_rut":"71200007-7","prior_source":"workera","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]',
      '[{"id":"b1200000-0000-4000-8000-000000000308","prior_rut":"71200009-9","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]',
      'b1200000-0000-4000-8000-000000000101')$$,
  '40001', null, 'deactivate con updated_at cambiado falla stale'
);
reset role;
select ok((select hire_date is null and updated_at = '2026-09-07 10:00:00+00' from public.employees where id = 'b1200000-0000-4000-8000-000000000306'), 'bloque update anterior se revierte');
select ok((select active and updated_at <> '2026-09-07 10:00:00+00' from public.employees where id = 'b1200000-0000-4000-8000-000000000308'), 'fila stale conserva estado concurrente');

-- Grupos y fuente siguen acotados al tenant.
set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001',
      '[{"rut":"71200020-0","first_name":"GRUPO","last_name":"AJENO","display_name":"GRUPO AJENO","employee_group_id":"b1200000-0000-4000-8000-000000000202","hire_date":""}]',
      '[]', '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '22023', null, 'alta no acepta grupo de otro tenant'
);
reset role;
select is((select count(*) from public.employees where rut = '71200020-0'), 0::bigint, 'alta ajena no deja fila');

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]',
      '[{"id":"b1200000-0000-4000-8000-000000000306","employee_group_id":"b1200000-0000-4000-8000-000000000202","hire_date":"","prior_rut":"71200007-7","prior_source":"workera","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]',
      '[]', 'b1200000-0000-4000-8000-000000000101')$$,
  '22023', null, 'update no acepta grupo de otro tenant'
);
reset role;
select ok((select employee_group_id = 'b1200000-0000-4000-8000-000000000201' and hire_date is null from public.employees where id = 'b1200000-0000-4000-8000-000000000306'), 'grupo ajeno no muta trabajador');

set local role authenticated;
set local request.jwt.claim.sub = 'b1200000-0000-4000-8000-000000000101';
select throws_ok(
  $$select public.apply_personnel_roster_import(
      'b1200000-0000-4000-8000-000000000001', '[]', '[]',
      '[{"id":"b1200000-0000-4000-8000-000000000306","prior_rut":"71200007-7","prior_source":"workera","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]',
      'b1200000-0000-4000-8000-000000000101')$$,
  '22023', null, 'deactivate no acepta fuente Workera'
);
reset role;
select ok((select active and hire_date is null from public.employees where id = 'b1200000-0000-4000-8000-000000000306'), 'intento de baja Workera no muta');

select * from finish();
rollback;
