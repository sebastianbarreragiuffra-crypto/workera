-- pgTAP: el motor solo abre corridas sobre una fuente sincronizada y
-- normalizada, y el preflight recibe una señal causal sin leer revisiones
-- privadas directamente.
create extension if not exists pgtap;

begin;
select plan(16);

select has_function(
  'public', 'begin_attendance_rule_engine_run',
  array['uuid', 'date', 'text', 'uuid'],
  'existe la apertura fenced del motor de asistencia'
);

select ok(
  pg_catalog.to_regclass('public.attendance_rule_engine_day_readiness') is not null,
  'existe la vista agregada de vigencia diaria'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid)',
    'EXECUTE'
  ),
  'solo service_role puede abrir una corrida del motor'
);

select ok(
  has_table_privilege(
    'service_role', 'public.attendance_rule_engine_day_readiness', 'SELECT'
  )
  and not has_table_privilege(
    'authenticated', 'public.attendance_rule_engine_day_readiness', 'SELECT'
  ),
  'la señal agregada solo es visible para el servicio auditado'
);

select ok(
  pg_get_functiondef(
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid)'::regprocedure
  ) like '%order by sr.started_at desc, sr.id desc%'
  and pg_get_functiondef(
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid)'::regprocedure
  ) like '%attendance_status = ''UNKNOWN_EXTERNAL_STATUS''%'
  and pg_get_functiondef(
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid)'::regprocedure
  ) like '%payroll-source-mutation-v1%',
  'la apertura valida la última sync y estados desconocidos dentro del lock global'
);

select ok(
  has_function_privilege(
    'service_role',
    'private.attendance_rule_engine_input_is_fresh(uuid,date,timestamptz,bigint,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'private.attendance_rule_engine_input_is_fresh(uuid,date,timestamptz,bigint,bigint)',
    'EXECUTE'
  ),
  'solo la vista de servicio puede resolver las revisiones privadas'
);

select ok(
  pg_get_functiondef(
    'private.attendance_rule_engine_input_is_fresh(uuid,date,timestamptz,bigint,bigint)'::regprocedure
  ) like '%r.revision = p_input_revision%'
  and pg_get_functiondef(
    'private.attendance_rule_engine_input_is_fresh(uuid,date,timestamptz,bigint,bigint)'::regprocedure
  ) like '%r.revision = p_day_input_revision%'
  and pg_get_functiondef(
    'private.attendance_rule_engine_input_is_fresh(uuid,date,timestamptz,bigint,bigint)'::regprocedure
  ) like '%p_finished_at >= sync.finished_at%'
  and pg_get_viewdef('public.attendance_rule_engine_day_readiness'::regclass, true)
    like '%attendance_rule_engine_input_is_fresh%',
  'la vista invoker compara revisiones vigentes y causalidad mediante el helper mínimo'
);

select throws_ok(
  $$ select public.begin_attendance_rule_engine_run(
       '0a4c0000-0000-0000-0000-000000000001'::uuid,
       date '2097-01-01', 'MANUAL', null
     ) $$,
  '55000',
  'Falta una sincronizacion Workera valida para la fecha solicitada.',
  'ARCOTEX no procesa una fecha sin sincronización requerida'
);

insert into public.sync_runs (
  id, company_id, started_at, finished_at, status,
  target_period_start, target_period_end, triggered_by
) values (
  'a7120000-0000-4000-8000-000000000101',
  '0a4c0000-0000-0000-0000-000000000001',
  timestamptz '2026-01-02 10:00:00+00',
  timestamptz '2026-01-02 10:01:00+00',
  'SUCCEEDED', date '2097-01-02', date '2097-01-02', 'MANUAL'
);

create temporary table readiness_test_runs (
  label text primary key,
  id uuid not null
) on commit drop;

select lives_ok(
  $$ insert into readiness_test_runs (label, id)
     select 'valid', public.begin_attendance_rule_engine_run(
       '0a4c0000-0000-0000-0000-000000000001'::uuid,
       date '2097-01-02', 'MANUAL', null
     ) $$,
  'una sync exitosa y normalizada permite abrir el motor'
);

select ok(
  (select id is not null from readiness_test_runs where label = 'valid'),
  'la apertura válida entrega un lease identificable'
);

select is(
  (
    select is_input_fresh
    from public.attendance_rule_engine_day_readiness
    where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
      and work_date = date '2097-01-02'
  ),
  false,
  'una corrida RUNNING todavía no es evidencia fresca'
);

select is(
  public.finish_attendance_rule_engine_run(
    '0a4c0000-0000-0000-0000-000000000001'::uuid,
    (select id from readiness_test_runs where label = 'valid'),
    'SUCCEEDED', 1, 1, 0, 0, 0, 0, 0, null
  ),
  'FINISHED',
  'la corrida válida se cierra con su revisión capturada'
);

select is(
  (
    select is_input_fresh
    from public.attendance_rule_engine_day_readiness
    where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
      and work_date = date '2097-01-02'
  ),
  true,
  'el ledger terminado después de la sync queda causalmente fresco'
);

insert into public.sync_runs (
  id, company_id, started_at, finished_at, status,
  target_period_start, target_period_end, triggered_by, error_category
) values (
  'a7120000-0000-4000-8000-000000000102',
  '0a4c0000-0000-0000-0000-000000000001',
  timestamptz '2030-01-02 10:00:00+00',
  timestamptz '2030-01-02 10:01:00+00',
  'FAILED', date '2097-01-02', date '2097-01-02', 'MANUAL', 'DATABASE'
);

select is(
  (
    select is_input_fresh
    from public.attendance_rule_engine_day_readiness
    where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
      and work_date = date '2097-01-02'
  ),
  false,
  'una sync posterior fallida invalida el éxito histórico'
);

select throws_ok(
  $$ select public.begin_attendance_rule_engine_run(
       '0a4c0000-0000-0000-0000-000000000001'::uuid,
       date '2097-01-02', 'MANUAL', null
     ) $$,
  '55000',
  'La ultima sincronizacion Workera de la fecha no termino correctamente.',
  'el runner no abre sobre la última sync fallida'
);

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id
) values (
  'a7120000-0000-4000-8000-000000000201',
  '0a4c0000-0000-0000-0000-000000000001',
  'TEST-READINESS-112', 'Motor', 'Readiness', 'Motor Readiness',
  (
    select eg.id from public.employee_groups eg
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and eg.code = 'PRODUCTION'
  )
);

insert into public.sync_runs (
  id, company_id, started_at, finished_at, status,
  target_period_start, target_period_end, triggered_by,
  records_read, records_created
) values (
  'a7120000-0000-4000-8000-000000000103',
  '0a4c0000-0000-0000-0000-000000000001',
  timestamptz '2026-01-03 10:00:00+00',
  timestamptz '2026-01-03 10:01:00+00',
  'SUCCEEDED', date '2097-01-03', date '2097-01-03', 'MANUAL', 1, 1
);

insert into public.workera_attendance_events (
  id, company_id, employee_id, external_employee_code, work_date,
  attendance_timestamp_raw, attendance_type_code, attendance_type_label,
  attendance_status, external_attendance_status, sync_run_id
) values (
  'a7120000-0000-4000-8000-000000000301',
  '0a4c0000-0000-0000-0000-000000000001',
  'a7120000-0000-4000-8000-000000000201', 'TEST-READINESS-112',
  date '2097-01-03', '2097-01-03T08:00:00', 0, 'ENTRADA',
  'UNKNOWN_EXTERNAL_STATUS', 'Estado futuro',
  'a7120000-0000-4000-8000-000000000103'
);

select throws_ok(
  $$ select public.begin_attendance_rule_engine_run(
       '0a4c0000-0000-0000-0000-000000000001'::uuid,
       date '2097-01-03', 'MANUAL', null
     ) $$,
  '55000',
  'La fuente contiene estados Workera sin normalizar.',
  'el runner no abre si queda un estado externo desconocido'
);

select * from finish();
rollback;
