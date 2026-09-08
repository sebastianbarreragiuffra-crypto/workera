-- pgTAP: ejecutar solo en una Supabase local aislada compatible con la rama.
create extension if not exists pgtap;

begin;
select plan(33);

select has_table(
  'public', 'reporting_period_approvals',
  'existe historial inmutable de aprobaciones RR. HH.'
);

select has_function(
  'public', 'guard_reporting_period_initial_state', array[]::text[],
  'existe el guard universal del estado inicial'
);

select trigger_is(
  'public', 'reporting_periods', 'reporting_periods_guard_initial_state',
  'public', 'guard_reporting_period_initial_state',
  'todo INSERT de período pasa por el guard universal'
);

select throws_ok(
  $$
    insert into public.reporting_periods(period_start, period_end, status)
    values (date '2099-01-16', date '2099-02-15', 'READY_TO_CLOSE')
  $$,
  '42501',
  'Un período nuevo debe comenzar OPEN y sin evidencia de cierre o reapertura.',
  'ni el dueño de migración puede insertar un período ya aprobado'
);

insert into public.reporting_periods(period_start, period_end, status)
values (date '2099-02-16', date '2099-03-15', 'OPEN');

select throws_ok(
  $$
    update public.reporting_periods
    set status = 'READY_TO_CLOSE'
    where period_start = date '2099-02-16'
      and period_end = date '2099-03-15'
  $$,
  '42501',
  'La transicion de estado OPEN -> READY_TO_CLOSE no esta permitida.',
  'ni el dueño de migración puede aprobar mediante UPDATE directo'
);

select has_function(
  'public',
  'approve_reporting_period_ready',
  array['uuid','uuid','uuid','reporting_period_status','bigint','uuid','text'],
  'existe el commit atómico de aprobación'
);

select ok(
  (select prosecdef from pg_proc
   where oid = 'public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)'::regprocedure),
  'el commit es SECURITY DEFINER'
);

select ok(
  (select provolatile = 'v' from pg_proc
   where oid = 'public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)'::regprocedure),
  'el commit es VOLATILE'
);

select ok(not has_function_privilege(
  'authenticated',
  'public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)',
  'EXECUTE'
), 'authenticated no aprueba directamente');

select ok(not has_function_privilege(
  'anon',
  'public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)',
  'EXECUTE'
), 'anon no aprueba');

select ok(has_function_privilege(
  'service_role',
  'public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)',
  'EXECUTE'
), 'solo la frontera service_role confirma');

select ok(
  has_table_privilege('authenticated', 'public.reporting_period_approvals', 'SELECT')
  and not has_table_privilege('authenticated', 'public.reporting_period_approvals', 'INSERT,UPDATE,DELETE'),
  'las sesiones solo leen el historial autorizado'
);

select ok(
  pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure)
    like '%new.status = ''READY_TO_CLOSE''%not v_trusted_approval%',
  'el guard bloquea READY_TO_CLOSE sin protocolo confiable'
);

select ok(
  lower(pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure))
    like '%v_trusted_approval := coalesce(%false%',
  'un GUC ausente se interpreta como falso y nunca abre un bypass SQL de tres valores'
);

select ok(
  pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure)
    like '%new.period_start is distinct from old.period_start%new.period_end is distinct from old.period_end%'
  and pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure)
    like '%old.status = ''CLOSED''%enforce_mfa_for_privileged()%request_is_aal2()%',
  'el rango 16-15 queda inmutable y una reapertura directa exige MFA real'
);

select ok(
  pg_get_functiondef('private.advance_arcotex_payroll_source_revision(uuid)'::regprocedure)
    like '%PAYROLL_APPROVAL_INVALIDATED_BY_SOURCE_CHANGE%'
  and pg_get_functiondef('private.advance_arcotex_payroll_source_revision(uuid)'::regprocedure)
    like '%status = ''IN_REVIEW''%',
  'una fuente modificada invalida la aprobación visible'
);

select ok(exists (
  select 1 from pg_trigger t
  where t.tgrelid = 'public.overtime_policies'::regclass
    and t.tgname = 'payroll_source_revision_fence'
    and not t.tgisinternal
), 'overtime_policies participa en el fence MVCC');

select ok(exists (
  select 1 from pg_trigger t
  where t.tgrelid = 'public.bonus_policies'::regclass
    and t.tgname = 'payroll_source_revision_fence'
    and not t.tgisinternal
), 'bonus_policies participa en el fence MVCC');

select ok(
  exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = 'public.bonus_policies'::regclass
      and c.conname = 'bonus_policies_payroll_2026_canonical_chk'
      and c.contype = 'c'
  ),
  'el bono canónico queda fijado por constraint'
);

select ok(
  not has_table_privilege('authenticated', 'public.bonus_policies', 'INSERT')
  and not has_table_privilege('authenticated', 'public.bonus_policies', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.bonus_policies', 'DELETE'),
  'ninguna sesión cambia monto o umbral del bono fijo'
);

select ok(
  (select with_check from pg_policies
   where schemaname = 'public' and tablename = 'reporting_periods'
     and policyname = 'reporting_periods_insert_admin') like '%status = ''OPEN''%'
  and (select with_check from pg_policies
   where schemaname = 'public' and tablename = 'reporting_periods'
     and policyname = 'reporting_periods_insert_admin') like '%request_is_aal2%',
  'un período nuevo siempre nace OPEN y solo se crea con MFA'
);

select ok(
  (select with_check from pg_policies
   where schemaname = 'public' and tablename = 'reporting_periods'
     and policyname = 'reporting_periods_update_admin') like '%READY_TO_CLOSE%'
  and (select with_check from pg_policies
   where schemaname = 'public' and tablename = 'reporting_periods'
     and policyname = 'reporting_periods_update_admin') like '%CLOSED%'
  and (select qual from pg_policies
   where schemaname = 'public' and tablename = 'reporting_periods'
     and policyname = 'reporting_periods_update_admin') like '%request_is_aal2%'
  and (select with_check from pg_policies
   where schemaname = 'public' and tablename = 'reporting_periods'
     and policyname = 'reporting_periods_update_admin') like '%request_is_aal2%',
  'el UPDATE de sesión exige MFA y excluye aprobación y cierre'
);

select ok(
  strpos(
    pg_get_functiondef('public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)'::regprocedure),
    'from private.payroll_source_revisions'
  ) < strpos(
    pg_get_functiondef('public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)'::regprocedure),
    'from public.reporting_periods rp'
  ),
  'la revisión se bloquea antes que el período para evitar deadlock'
);

select ok(
  pg_get_functiondef('public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)'::regprocedure)
    like '%payroll_workbook_source_attestations%source_revision = v_source_revision%',
  'la versión ACCEPTED debe corresponder a la revisión aprobada'
);

select ok(
  pg_get_functiondef('public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)'::regprocedure)
    like '%v.period_start = v_period.period_start%v.period_end = v_period.period_end%',
  'la base aceptada coincide con el rango bloqueado'
);

select ok(
  pg_get_functiondef('public.approve_reporting_period_ready(uuid,uuid,uuid,public.reporting_period_status,bigint,uuid,text)'::regprocedure)
    like '%payroll_workbook_conflicts%resolved_at is null%',
  'los conflictos abiertos bloquean la aprobación'
);

select ok(
  (select qual from pg_policies where schemaname='public' and tablename='payroll_workbook_versions'
    and policyname='payroll_workbook_versions_read') like '%has_company_app_role%',
  'versiones XLSX usan rol del mismo tenant'
);

select ok(
  (select qual from pg_policies where schemaname='public' and tablename='payroll_workbook_changes'
    and policyname='payroll_workbook_changes_read') like '%has_company_app_role%',
  'cambios XLSX usan rol del mismo tenant'
);

select ok(
  (select qual from pg_policies where schemaname='public' and tablename='payroll_workbook_conflicts'
    and policyname='payroll_workbook_conflicts_read') like '%has_company_app_role%',
  'conflictos XLSX usan rol del mismo tenant'
);

select ok(
  (select with_check from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='payroll_workbooks_storage_insert') like '%owner_id = (auth.uid())::text%'
  and (select with_check from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='payroll_workbooks_storage_insert') like '%has_company_app_role%'
  and (select with_check from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='payroll_workbooks_storage_insert') like '%CASE%',
  'la subida privada valida UUID y rol dentro del mismo tenant'
);

select ok(
  pg_get_functiondef('public.set_time_control_exemption(uuid,text,date,text,uuid)'::regprocedure)
    like '%payroll-source-mutation-v1%assert_arcotex_payroll_range_mutable%',
  'crear o cambiar una exención serializa con el cierre y respeta CLOSED'
);
select ok(
  pg_get_functiondef('public.clear_time_control_exemption(uuid,date)'::regprocedure)
    like '%payroll-source-mutation-v1%assert_arcotex_payroll_range_mutable%',
  'terminar o cancelar exenciones no reescribe un período CLOSED'
);
select ok(
  not has_table_privilege('service_role', 'public.employee_time_control_policies', 'INSERT')
  and not has_table_privilege('service_role', 'public.employee_time_control_policies', 'UPDATE')
  and not has_table_privilege('service_role', 'public.employee_time_control_policies', 'DELETE'),
  'service_role tampoco puede evitar la frontera mediante DML directo'
);

select * from finish();
rollback;
