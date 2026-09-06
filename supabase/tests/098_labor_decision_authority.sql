-- pgTAP: ejecutar solo en una Supabase local aislada compatible con la rama.
create extension if not exists pgtap;

begin;
select plan(19);

select has_function(
  'public', 'can_manage_employee_on_date', array['uuid', 'date'],
  'existe autoridad laboral fechada'
);
select has_function(
  'public', 'can_manage_employee_for_date_range', array['uuid', 'date', 'date'],
  'existe autoridad laboral segura para rangos de ausencia'
);

select unlike(
  pg_get_functiondef('public.can_manage_employee(uuid)'::regprocedure),
  '%is_privileged_admin%',
  'can_manage_employee no concede mutaciones laborales a SUPER_ADMIN'
);
select like(
  pg_get_functiondef('public.can_manage_employee_on_date(uuid,date)'::regprocedure),
  '%has_company_app_role%',
  'ADMIN_RRHH conserva autoridad laboral dentro de la empresa del hecho'
);
select like(
  pg_get_functiondef('public.can_manage_employee_on_date(uuid,date)'::regprocedure),
  '%employee_group_assignments%',
  'la competencia del supervisor usa el grupo histórico'
);
select unlike(
  pg_get_functiondef('public.can_manage_employee_on_date(uuid,date)'::regprocedure),
  '%e.employee_group_id%',
  'la competencia histórica no depende del grupo actual del trabajador'
);

select ok((select with_check like '%can_manage_employee_on_date%'
  from pg_policies where schemaname='public' and tablename='overtime_decisions'
  and policyname='overtime_decisions_insert'), 'HE inserta mediante autoridad laboral');
select ok((select with_check like '%can_manage_employee_on_date%'
  from pg_policies where schemaname='public' and tablename='late_arrival_decisions'
  and policyname='late_arrival_decisions_insert'), 'atrasos insertan mediante autoridad laboral');
select ok((select with_check like '%can_manage_employee_on_date%'
  from pg_policies where schemaname='public' and tablename='early_departure_decisions'
  and policyname='early_departure_decisions_insert'), 'salidas insertan mediante autoridad laboral');
select ok((select with_check like '%can_manage_employee%'
  from pg_policies where schemaname='public' and tablename='absence_decisions'
  and policyname='absence_decisions_insert'), 'ausencias insertan mediante autoridad laboral');
select ok((select with_check like '%can_manage_employee_for_date_range%'
  from pg_policies where schemaname='public' and tablename='absence_decisions'
  and policyname='absence_decisions_insert'), 'la decisión de ausencia cubre todo su rango histórico');
select unlike(
  coalesce((select with_check from pg_policies
    where schemaname='public' and tablename='absence_decisions'
      and policyname='absence_decisions_insert'), ''),
  '%can_manage_employee(ar.employee_id)%',
  'la ausencia no usa el grupo actual del trabajador'
);
select ok((select with_check like '%has_company_app_role%'
  from pg_policies where schemaname='public' and tablename='absence_records'
  and policyname='absence_records_insert'), 'la carga no manual exige RR. HH. del tenant exacto');
select unlike(
  coalesce((select with_check from pg_policies
    where schemaname='public' and tablename='absence_records'
      and policyname='absence_records_insert'), ''),
  '%is_admin_rrhh%',
  'la carga de ausencias no combina un rol global con otro tenant'
);
select has_function(
  'public', 'prevent_labor_decision_on_closed_period', array[]::text[],
  'existe el bloqueo transversal de decisiones en período cerrado'
);
select trigger_is(
  'public', 'absence_decisions', 'absence_decisions_prevent_closed_period',
  'prevent_labor_decision_on_closed_period',
  'las ausencias respetan el cierre inmutable'
);
select like(
  pg_get_functiondef('public.prevent_labor_decision_on_closed_period()'::regprocedure),
  '%daterange(v_start_date, v_end_date%',
  'el bloqueo de ausencia evalúa el rango completo'
);
select like(
  pg_get_functiondef('public.prevent_labor_decision_on_closed_period()'::regprocedure),
  '%rp.status = ''CLOSED''%',
  'el bloqueo consulta el estado cerrado real'
);
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='early_departure_decisions'
      and cmd in ('UPDATE', 'ALL')
  )
  and not has_table_privilege('authenticated', 'public.early_departure_decisions', 'UPDATE'),
  'una sesión no muta una decisión previa; RR. HH. la reemplaza insertando otra fila'
);

select * from finish();
rollback;
