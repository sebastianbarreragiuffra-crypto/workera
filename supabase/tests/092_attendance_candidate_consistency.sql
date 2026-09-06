-- pgTAP: consistencia entre asistencia, candidatos y decisiones; además,
-- recuperación de corridas del motor aislada por empresa.
create extension if not exists pgtap;

begin;
select plan(26);

-- ---------------------------------------------------------------------------
-- Estructura: la salida anticipada queda alineada con atraso y horas extra.
select has_index(
  'public', 'early_departure_records',
  'early_departure_records_current_per_day_key',
  'existe el índice de unicidad vigente de salidas anticipadas'
);

select ok(
  exists (
    select 1
    from pg_catalog.pg_index idx
    join pg_catalog.pg_class index_rel on index_rel.oid = idx.indexrelid
    join pg_catalog.pg_class table_rel on table_rel.oid = idx.indrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = table_rel.relnamespace
    where nsp.nspname = 'public'
      and table_rel.relname = 'early_departure_records'
      and index_rel.relname = 'early_departure_records_current_per_day_key'
      and idx.indisunique
      and pg_get_expr(idx.indpred, idx.indrelid) = 'is_current'
      and (
        select array_agg(att.attname order by keys.ordinality)
        from unnest(idx.indkey) with ordinality as keys(attnum, ordinality)
        join pg_catalog.pg_attribute att
          on att.attrelid = idx.indrelid and att.attnum = keys.attnum
      ) = array['employee_id', 'work_date']::name[]
  ),
  'el índice es UNIQUE(employee_id, work_date) únicamente para is_current'
);

select has_trigger(
  'public', 'late_arrival_decisions',
  'late_arrival_decisions_candidate_current_guard',
  'late_arrival_decisions protege la vigencia del candidato y su asistencia'
);
select has_trigger(
  'public', 'early_departure_decisions',
  'early_departure_decisions_candidate_current_guard',
  'early_departure_decisions protege la vigencia del candidato y su asistencia'
);
select has_trigger(
  'public', 'overtime_decisions',
  'overtime_decisions_candidate_current_guard',
  'overtime_decisions protege la vigencia del candidato y su asistencia'
);
select has_function(
  'public', 'assert_decision_candidate_is_current', array[]::text[],
  'existe el guard común de decisiones de asistencia'
);

-- ---------------------------------------------------------------------------
-- RPC de recuperación: firma explícita por tenant y privilegios server-only.
select has_function(
  'public', 'reclaim_stale_rule_engine_runs', array['uuid', 'integer'],
  'reclaim_stale_rule_engine_runs exige company_id explícito'
);
select ok(
  to_regprocedure('public.reclaim_stale_rule_engine_runs(integer)') is null,
  'la firma global antigua de reclaim_stale_rule_engine_runs ya no existe'
);
select ok(
  not has_function_privilege(
    'public', 'public.reclaim_stale_rule_engine_runs(uuid,integer)', 'EXECUTE'
  ),
  'PUBLIC no puede recuperar corridas del motor'
);
select ok(
  not has_function_privilege(
    'anon', 'public.reclaim_stale_rule_engine_runs(uuid,integer)', 'EXECUTE'
  ),
  'anon no puede recuperar corridas del motor'
);
select ok(
  not has_function_privilege(
    'authenticated', 'public.reclaim_stale_rule_engine_runs(uuid,integer)', 'EXECUTE'
  ),
  'authenticated no puede recuperar corridas del motor'
);
select ok(
  has_function_privilege(
    'service_role', 'public.reclaim_stale_rule_engine_runs(uuid,integer)', 'EXECUTE'
  ),
  'service_role sí puede recuperar corridas del motor'
);

-- ---------------------------------------------------------------------------
-- Fixtures de las tres familias candidato/decisión.
insert into public.profiles (id, display_name, role, active)
values (
  '92000000-0000-4000-8000-000000000101',
  'Fixture consistencia 092', 'ADMIN_RRHH', true
);

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id
) values (
  '92000000-0000-4000-8000-000000000201',
  '0a4c0000-0000-0000-0000-000000000001',
  'TEST-CONSISTENCY-092', 'Fixture', 'Consistencia', 'Fixture Consistencia 092',
  (
    select id from public.employee_groups
    where company_id = '0a4c0000-0000-0000-0000-000000000001'
      and code = 'PRODUCTION'
  )
);

insert into public.attendance_records (
  id, employee_id, work_date, actual_clock_in, actual_clock_out,
  source, source_hash, source_version, is_current
) values
  (
    '92000000-0000-4000-8000-000000000301',
    '92000000-0000-4000-8000-000000000201', '2026-09-10',
    '2026-09-10 08:15:00-03', '2026-09-10 17:00:00-03',
    'manual', 'consistency-092-stale-attendance', 1, false
  ),
  (
    '92000000-0000-4000-8000-000000000302',
    '92000000-0000-4000-8000-000000000201', '2026-09-11',
    '2026-09-11 08:15:00-03', '2026-09-11 17:00:00-03',
    'manual', 'consistency-092-current-attendance-1', 1, true
  ),
  (
    '92000000-0000-4000-8000-000000000303',
    '92000000-0000-4000-8000-000000000201', '2026-09-12',
    '2026-09-12 08:00:00-03', '2026-09-12 16:50:00-03',
    'manual', 'consistency-092-current-attendance-2', 1, true
  );

-- Candidatos actuales que apuntan a una asistencia histórica.
insert into public.late_arrival_records (
  id, employee_id, work_date, attendance_record_id, scheduled_start,
  actual_start, detected_minutes, late_arrival_policy_id, is_current
) values (
  '92000000-0000-4000-8000-000000000411',
  '92000000-0000-4000-8000-000000000201', '2026-09-10',
  '92000000-0000-4000-8000-000000000301', '08:00:00',
  '2026-09-10 08:15:00-03', 15,
  (
    select lap.id
    from public.late_arrival_policies lap
    join public.employee_groups eg on eg.id = lap.employee_group_id
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and eg.code = 'PRODUCTION'
    order by lap.id
    limit 1
  ), true
);

insert into public.early_departure_records (
  id, employee_id, work_date, attendance_record_id, scheduled_end,
  actual_end, detected_minutes, is_current
) values (
  '92000000-0000-4000-8000-000000000412',
  '92000000-0000-4000-8000-000000000201', '2026-09-10',
  '92000000-0000-4000-8000-000000000301', '17:30:00',
  '2026-09-10 17:00:00-03', 30, true
);

insert into public.overtime_records (
  id, employee_id, work_date, attendance_record_id, overtime_type_id,
  candidate_minutes, overtime_policy_id, is_current
) values (
  '92000000-0000-4000-8000-000000000413',
  '92000000-0000-4000-8000-000000000201', '2026-09-10',
  '92000000-0000-4000-8000-000000000301',
  (select id from public.overtime_types where code = 'OVERTIME_50'), 30,
  (
    select op.id
    from public.overtime_policies op
    join public.employee_groups eg on eg.id = op.employee_group_id
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and eg.code = 'PRODUCTION'
    order by op.id
    limit 1
  ), true
);

-- Candidatos históricos que apuntan a una asistencia actual.
insert into public.late_arrival_records (
  id, employee_id, work_date, attendance_record_id, scheduled_start,
  actual_start, detected_minutes, late_arrival_policy_id, is_current
) values (
  '92000000-0000-4000-8000-000000000421',
  '92000000-0000-4000-8000-000000000201', '2026-09-11',
  '92000000-0000-4000-8000-000000000302', '08:00:00',
  '2026-09-11 08:15:00-03', 15,
  (
    select lap.id
    from public.late_arrival_policies lap
    join public.employee_groups eg on eg.id = lap.employee_group_id
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and eg.code = 'PRODUCTION'
    order by lap.id
    limit 1
  ), false
);

insert into public.early_departure_records (
  id, employee_id, work_date, attendance_record_id, scheduled_end,
  actual_end, detected_minutes, is_current
) values (
  '92000000-0000-4000-8000-000000000422',
  '92000000-0000-4000-8000-000000000201', '2026-09-11',
  '92000000-0000-4000-8000-000000000302', '17:30:00',
  '2026-09-11 17:00:00-03', 30, false
);

insert into public.overtime_records (
  id, employee_id, work_date, attendance_record_id, overtime_type_id,
  candidate_minutes, overtime_policy_id, is_current
) values (
  '92000000-0000-4000-8000-000000000423',
  '92000000-0000-4000-8000-000000000201', '2026-09-11',
  '92000000-0000-4000-8000-000000000302',
  (select id from public.overtime_types where code = 'OVERTIME_50'), 30,
  (
    select op.id
    from public.overtime_policies op
    join public.employee_groups eg on eg.id = op.employee_group_id
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and eg.code = 'PRODUCTION'
    order by op.id
    limit 1
  ), false
);

-- Un candidato plenamente vigente para probar unicidad y el camino permitido.
insert into public.early_departure_records (
  id, employee_id, work_date, attendance_record_id, scheduled_end,
  actual_end, detected_minutes, calculation_version, is_current
) values (
  '92000000-0000-4000-8000-000000000430',
  '92000000-0000-4000-8000-000000000201', '2026-09-12',
  '92000000-0000-4000-8000-000000000303', '17:00:00',
  '2026-09-12 16:50:00-03', 10, 1, true
);

select throws_ok(
  $$ insert into public.early_departure_records (
       id, employee_id, work_date, attendance_record_id, scheduled_end,
       actual_end, detected_minutes, calculation_version, is_current
     ) values (
       '92000000-0000-4000-8000-000000000431',
       '92000000-0000-4000-8000-000000000201', '2026-09-12',
       '92000000-0000-4000-8000-000000000303', '17:00:00',
       '2026-09-12 16:45:00-03', 15, 2, true
     ) $$,
  '23505', null,
  'no admite dos salidas anticipadas actuales del mismo trabajador y día'
);

-- ---------------------------------------------------------------------------
-- El guard rechaza por igual las tres familias si el candidato es histórico.
select throws_ok(
  $$ insert into public.late_arrival_decisions (
       late_arrival_record_id, justified, payroll_minutes, payroll_effect, decided_by
     ) values (
       '92000000-0000-4000-8000-000000000421', false, 15, 'DEDUCT',
       '92000000-0000-4000-8000-000000000101'
     ) $$,
  'P0001', 'Cannot decide a stale or missing attendance candidate.',
  'no permite decidir un atraso histórico'
);
select throws_ok(
  $$ insert into public.early_departure_decisions (
       early_departure_record_id, reason_category, payroll_minutes,
       payroll_effect, decided_by
     ) values (
       '92000000-0000-4000-8000-000000000422', 'UNJUSTIFIED', 30,
       'DEDUCT', '92000000-0000-4000-8000-000000000101'
     ) $$,
  'P0001', 'Cannot decide a stale or missing attendance candidate.',
  'no permite decidir una salida anticipada histórica'
);
select throws_ok(
  $$ insert into public.overtime_decisions (
       overtime_record_id, approved_minutes, rejected_minutes,
       decision_status, decided_by
     ) values (
       '92000000-0000-4000-8000-000000000423', 30, 0,
       'FULLY_APPROVED', '92000000-0000-4000-8000-000000000101'
     ) $$,
  'P0001', 'Cannot decide a stale or missing attendance candidate.',
  'no permite decidir una hora extra histórica'
);

-- También rechaza un candidato aún current si su asistencia raíz fue retirada.
select throws_ok(
  $$ insert into public.late_arrival_decisions (
       late_arrival_record_id, justified, payroll_minutes, payroll_effect, decided_by
     ) values (
       '92000000-0000-4000-8000-000000000411', false, 15, 'DEDUCT',
       '92000000-0000-4000-8000-000000000101'
     ) $$,
  'P0001', 'Cannot decide a candidate whose attendance record is stale or missing.',
  'no permite decidir un atraso cuya asistencia raíz es histórica'
);
select throws_ok(
  $$ insert into public.early_departure_decisions (
       early_departure_record_id, reason_category, payroll_minutes,
       payroll_effect, decided_by
     ) values (
       '92000000-0000-4000-8000-000000000412', 'UNJUSTIFIED', 30,
       'DEDUCT', '92000000-0000-4000-8000-000000000101'
     ) $$,
  'P0001', 'Cannot decide a candidate whose attendance record is stale or missing.',
  'no permite decidir una salida cuya asistencia raíz es histórica'
);
select throws_ok(
  $$ insert into public.overtime_decisions (
       overtime_record_id, approved_minutes, rejected_minutes,
       decision_status, decided_by
     ) values (
       '92000000-0000-4000-8000-000000000413', 30, 0,
       'FULLY_APPROVED', '92000000-0000-4000-8000-000000000101'
     ) $$,
  'P0001', 'Cannot decide a candidate whose attendance record is stale or missing.',
  'no permite decidir horas extra cuya asistencia raíz es histórica'
);

select lives_ok(
  $$ insert into public.early_departure_decisions (
       early_departure_record_id, reason_category, payroll_minutes,
       payroll_effect, decided_by
     ) values (
       '92000000-0000-4000-8000-000000000430', 'UNJUSTIFIED', 10,
       'DEDUCT', '92000000-0000-4000-8000-000000000101'
     ) $$,
  'una decisión válida sigue permitida cuando candidato y asistencia son actuales'
);

-- ---------------------------------------------------------------------------
-- Aislamiento del reclaim: misma fecha, dos empresas, solo cambia la solicitada.
insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  '92000000-0000-4000-8000-000000000501',
  'Empresa ajena 092', 'Empresa ajena 092 SpA', 'empresa-ajena-092',
  true, 'ONBOARDING', false
);

insert into public.rule_engine_runs (
  id, company_id, work_date, status, triggered_by, started_at
) values
  (
    '92000000-0000-4000-8000-000000000601',
    '0a4c0000-0000-0000-0000-000000000001', '2026-10-01',
    'RUNNING', 'MANUAL', now() - interval '2 hours'
  ),
  (
    '92000000-0000-4000-8000-000000000602',
    '92000000-0000-4000-8000-000000000501', '2026-10-01',
    'RUNNING', 'MANUAL', now() - interval '2 hours'
  ),
  (
    '92000000-0000-4000-8000-000000000603',
    '0a4c0000-0000-0000-0000-000000000001', '2026-10-02',
    'RUNNING', 'MANUAL', now()
  );

set local role service_role;
select is(
  public.reclaim_stale_rule_engine_runs(
    '0a4c0000-0000-0000-0000-000000000001', 900
  ),
  1,
  'reclaim informa solo la corrida obsoleta de la empresa solicitada'
);
reset role;

select is(
  (select status from public.rule_engine_runs where id = '92000000-0000-4000-8000-000000000601'),
  'FAILED',
  'la corrida obsoleta del tenant solicitado queda FAILED'
);
select is(
  (select status from public.rule_engine_runs where id = '92000000-0000-4000-8000-000000000602'),
  'RUNNING',
  'la corrida obsoleta del otro tenant permanece intacta'
);
select is(
  (select status from public.rule_engine_runs where id = '92000000-0000-4000-8000-000000000603'),
  'RUNNING',
  'la corrida reciente del tenant solicitado permanece activa'
);

set local role service_role;
select throws_ok(
  $$ select public.reclaim_stale_rule_engine_runs(null::uuid, 900) $$,
  'P0001', 'p_company_id is required',
  'reclaim rechaza un company_id nulo'
);
select throws_ok(
  $$ select public.reclaim_stale_rule_engine_runs(
       '0a4c0000-0000-0000-0000-000000000001', 0
     ) $$,
  'P0001', 'p_stale_after_seconds must be positive',
  'reclaim rechaza un umbral no positivo'
);
reset role;

select * from finish();
rollback;
