-- pgTAP: ARCOTEX sólo abre el motor sobre sus 45 personas autorizadas y el
-- ledger permite demostrar exactamente ese alcance sin publicar el padrón.
create extension if not exists pgtap;

begin;
select plan(18);

select has_column(
  'public', 'rule_engine_runs', 'employee_scope_size',
  'el ledger guarda la cantidad del alcance explícito'
);

select has_column(
  'public', 'rule_engine_runs', 'employee_scope_sha256',
  'el ledger guarda la huella del alcance explícito'
);

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'rule_engine_runs_employee_scope_attestation_chk'
      and conrelid = 'public.rule_engine_runs'::regclass
  ),
  'cantidad y huella quedan ligadas por constraint'
);

select has_function(
  'public', 'begin_attendance_rule_engine_run',
  array['uuid', 'date', 'text', 'uuid', 'uuid[]'],
  'existe la apertura fenced con padrón explícito'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid,uuid[])',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid,uuid[])',
    'EXECUTE'
  ),
  'sólo service_role puede abrir una corrida con alcance explícito'
);

select ok(
  lower(pg_get_functiondef(
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid,uuid[])'::regprocedure
  )) like '%wae.employee_id = any(p_employee_ids)%'
  and lower(pg_get_functiondef(
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid,uuid[])'::regprocedure
  )) like '%e.company_id = p_company_id%'
  and lower(pg_get_functiondef(
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid,uuid[])'::regprocedure
  )) like '%employee_scope_sha256%'
  and lower(pg_get_functiondef(
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid,uuid[])'::regprocedure
  )) like '%payroll-source-mutation-v1%',
  'la apertura valida tenant, acota la fuente y persiste la atestación dentro del lock'
);

select ok(
  pg_get_viewdef('public.attendance_rule_engine_day_readiness'::regclass, true)
    like '%employee_scope_size%'
  and pg_get_viewdef('public.attendance_rule_engine_day_readiness'::regclass, true)
    like '%employee_scope_sha256%',
  'la vista de preflight expone sólo la atestación agregada'
);

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id
)
select
  ('a1160000-0000-4000-8000-' || pg_catalog.lpad(n::text, 12, '0'))::uuid,
  '0a4c0000-0000-0000-0000-000000000001'::uuid,
  'TEST-SCOPE-116-' || n::text,
  'Alcance', n::text, 'Alcance ' || n::text,
  (
    select eg.id from public.employee_groups eg
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
      and eg.code = 'PRODUCTION'
  )
from pg_catalog.generate_series(1, 46) as generated(n);

insert into public.sync_runs (
  id, company_id, started_at, finished_at, status,
  target_period_start, target_period_end, triggered_by,
  records_read, records_created
) values (
  'a1160000-0000-4000-8000-000000000101',
  '0a4c0000-0000-0000-0000-000000000001',
  timestamptz '2097-02-01 10:00:00+00',
  timestamptz '2097-02-01 10:01:00+00',
  'SUCCEEDED', date '2097-02-01', date '2097-02-01', 'MANUAL', 46, 46
);

insert into public.workera_attendance_events (
  id, company_id, employee_id, external_employee_code, work_date,
  attendance_timestamp_raw, attendance_type_code, attendance_type_label,
  attendance_status, external_attendance_status, sync_run_id
) values (
  'a1160000-0000-4000-8000-000000000201',
  '0a4c0000-0000-0000-0000-000000000001',
  'a1160000-0000-4000-8000-000000000046', 'TEST-SCOPE-116-46',
  date '2097-02-01', '2097-02-01T08:00:00', 0, 'ENTRADA',
  'UNKNOWN_EXTERNAL_STATUS', 'Estado sólo HOLDING',
  'a1160000-0000-4000-8000-000000000101'
);

create temporary table scope_test_data (
  employee_ids uuid[] not null,
  expected_sha256 text not null,
  run_id uuid
) on commit drop;

insert into scope_test_data (employee_ids, expected_sha256)
select
  pg_catalog.array_agg(e.id order by e.id::text),
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.string_agg(e.id::text, E'\n' order by e.id::text),
      'sha256'
    ),
    'hex'
  )
from public.employees e
where e.external_workera_id like 'TEST-SCOPE-116-%'
  and e.external_workera_id <> 'TEST-SCOPE-116-46';

select throws_ok(
  $$ select public.begin_attendance_rule_engine_run(
       '0a4c0000-0000-0000-0000-000000000001'::uuid,
       date '2097-02-01', 'MANUAL', null,
       (select employee_ids[1:44] from scope_test_data)
     ) $$,
  '22023',
  'El alcance autorizado de ARCOTEX debe contener exactamente 45 empleados.',
  'ARCOTEX rechaza un alcance de 44 personas'
);

select throws_ok(
  $$ select public.begin_attendance_rule_engine_run(
       '0a4c0000-0000-0000-0000-000000000001'::uuid,
       date '2097-02-01', 'MANUAL', null,
       array_append(
         (select employee_ids[1:44] from scope_test_data),
         '0b4c0000-0000-0000-0000-000000000002'::uuid
       )
     ) $$,
  '42501',
  'El alcance explicito no pertenece integramente a la empresa.',
  'el alcance no admite un UUID ajeno o inexistente'
);

select throws_ok(
  $$ select public.begin_attendance_rule_engine_run(
       '0a4c0000-0000-0000-0000-000000000001'::uuid,
       date '2097-02-01', 'MANUAL', null,
       array_append(
         (select employee_ids[1:44] from scope_test_data),
         (select employee_ids[1] from scope_test_data)
       )
     ) $$,
  '22023',
  'El alcance explicito contiene UUID nulos o duplicados.',
  'el alcance no admite UUID duplicados'
);

select lives_ok(
  $$ update scope_test_data
     set run_id = public.begin_attendance_rule_engine_run(
       '0a4c0000-0000-0000-0000-000000000001'::uuid,
       date '2097-02-01', 'MANUAL', null, employee_ids
     ) $$,
  'los 45 autorizados abren aunque un registro externo tenga estado desconocido'
);

select ok(
  (select run_id is not null from scope_test_data),
  'la apertura válida entrega un lease identificable'
);

select is(
  (
    select rr.employee_scope_size
    from public.rule_engine_runs rr
    where rr.id = (select run_id from scope_test_data)
  ),
  45,
  'el ledger registra exactamente 45 personas'
);

select is(
  (
    select rr.employee_scope_sha256
    from public.rule_engine_runs rr
    where rr.id = (select run_id from scope_test_data)
  ),
  (select expected_sha256 from scope_test_data),
  'la huella persistida corresponde a los UUID canónicos ordenados'
);

select ok(
  (
    select readiness.employee_scope_size = 45
      and readiness.employee_scope_sha256 = scope.expected_sha256
    from public.attendance_rule_engine_day_readiness readiness
    cross join scope_test_data scope
    where readiness.rule_engine_run_id = scope.run_id
  ),
  'el preflight recibe la misma atestación sin acceder al padrón'
);

select is(
  public.finish_attendance_rule_engine_run(
    '0a4c0000-0000-0000-0000-000000000001'::uuid,
    (select run_id from scope_test_data),
    'SUCCEEDED', 45, 45, 0, 0, 0, 0, 0, null
  ),
  'FINISHED',
  'la corrida autorizada se cierra normalmente'
);

insert into public.workera_attendance_events (
  id, company_id, employee_id, external_employee_code, work_date,
  attendance_timestamp_raw, attendance_type_code, attendance_type_label,
  attendance_status, external_attendance_status, sync_run_id
) values (
  'a1160000-0000-4000-8000-000000000202',
  '0a4c0000-0000-0000-0000-000000000001',
  (select employee_ids[1] from scope_test_data), 'TEST-SCOPE-116-1',
  date '2097-02-01', '2097-02-01T09:00:00', 0, 'ENTRADA',
  'UNKNOWN_EXTERNAL_STATUS', 'Estado dentro de ARCOTEX',
  'a1160000-0000-4000-8000-000000000101'
);

select throws_ok(
  $$ select public.begin_attendance_rule_engine_run(
       '0a4c0000-0000-0000-0000-000000000001'::uuid,
       date '2097-02-01', 'MANUAL', null,
       (select employee_ids from scope_test_data)
     ) $$,
  '55000',
  'La fuente contiene estados Workera sin normalizar dentro del alcance autorizado.',
  'un estado desconocido de los 45 sí bloquea el motor'
);

select ok(
  to_regprocedure('public.begin_attendance_rule_engine_run(uuid,date,text,uuid)') is not null,
  'la firma de tenant completo sigue disponible para otras empresas'
);

select * from finish();
rollback;
