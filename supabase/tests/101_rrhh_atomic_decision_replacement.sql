-- pgTAP: ejecutar solo en una Supabase local aislada compatible con la rama.
create extension if not exists pgtap;

begin;
select plan(13);

select has_function(
  'public', 'prepare_rrhh_labor_decision_replacement', array[]::text[],
  'existe el reemplazo laboral transaccional'
);

select ok(
  (select prosecdef from pg_proc where oid = 'public.prepare_rrhh_labor_decision_replacement()'::regprocedure),
  'el trigger revalida autoridad sin depender de permisos del cliente'
);

select ok(not has_function_privilege(
  'authenticated', 'public.prepare_rrhh_labor_decision_replacement()', 'EXECUTE'
), 'authenticated no puede invocar directamente la función de trigger');

select trigger_is(
  'public', 'overtime_decisions', 'overtime_decisions_prepare_rrhh_replacement',
  'public', 'prepare_rrhh_labor_decision_replacement',
  'horas extra preparan reemplazo atómico'
);
select trigger_is(
  'public', 'late_arrival_decisions', 'late_arrival_decisions_prepare_rrhh_replacement',
  'public', 'prepare_rrhh_labor_decision_replacement',
  'atrasos preparan reemplazo atómico'
);
select trigger_is(
  'public', 'early_departure_decisions', 'early_departure_decisions_prepare_rrhh_replacement',
  'public', 'prepare_rrhh_labor_decision_replacement',
  'salidas anticipadas preparan reemplazo atómico'
);
select trigger_is(
  'public', 'absence_decisions', 'absence_decisions_prepare_rrhh_replacement',
  'public', 'prepare_rrhh_labor_decision_replacement',
  'ausencias preparan reemplazo atómico'
);

select ok(
  pg_get_functiondef('public.prepare_rrhh_labor_decision_replacement()'::regprocedure)
    like '%for update%',
  'el reemplazo serializa sobre la decisión vigente'
);
select ok(
  pg_get_functiondef('public.prepare_rrhh_labor_decision_replacement()'::regprocedure)
    like '%has_company_app_role%',
  'solo RR. HH. de la empresa del hecho reemplaza'
);
select ok(
  pg_get_functiondef('public.prepare_rrhh_labor_decision_replacement()'::regprocedure)
    not like '%is_admin_rrhh%',
  'el reemplazo no combina el rol global con otra membresía'
);
select ok(
  pg_get_functiondef('public.prepare_rrhh_labor_decision_replacement()'::regprocedure)
    like '%btrim(new.reason)%',
  'todo reemplazo exige motivo'
);
select ok(
  pg_get_functiondef('public.prepare_rrhh_labor_decision_replacement()'::regprocedure)
    like '%set is_current = false%',
  'la fila previa se conserva como historial no vigente'
);
select ok(
  not has_table_privilege('authenticated', 'public.overtime_decisions', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.late_arrival_decisions', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.early_departure_decisions', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.absence_decisions', 'UPDATE')
  and not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('overtime_decisions', 'late_arrival_decisions', 'early_departure_decisions', 'absence_decisions')
      and cmd in ('UPDATE', 'ALL')
  ),
  'las sesiones no pueden editar decisiones históricas por UPDATE directo'
);

select * from finish();
rollback;
