-- pgTAP: ejecutar solo en una Supabase local aislada compatible con la rama.
create extension if not exists pgtap;

begin;
select plan(72);

select has_function(
  'private', 'advance_arcotex_payroll_source_revision', array['uuid'],
  'existe el avance de revision privado y tenant-scoped'
);

select ok(not has_function_privilege(
  'authenticated',
  'private.advance_arcotex_payroll_source_revision(uuid)',
  'EXECUTE'
), 'authenticated no puede avanzar revisiones manualmente');

select has_function(
  'private', 'lock_payroll_source_mutation', array[]::text[],
  'existe el lock previo que fija el orden de concurrencia'
);

select ok(exists (
  select 1
  from pg_trigger t
  where t.tgrelid = 'public.employees'::regclass
    and t.tgname = 'payroll_source_revision_lock'
    and (t.tgtype & 1) = 0
    and (t.tgtype & 2) = 2
    and not t.tgisinternal
), 'employees toma el advisory antes de buscar y bloquear filas');

select ok(exists (
  select 1
  from pg_trigger t
  where t.tgrelid = 'public.employees'::regclass
    and t.tgname = 'payroll_source_revision_fence'
    and (t.tgtype & 1) = 1
    and not t.tgisinternal
), 'employees usa fence por fila y no statement-level');

select ok(exists (
  select 1
  from pg_trigger t
  where t.tgrelid = 'public.overtime_policies'::regclass
    and t.tgname = 'payroll_source_revision_fence'
    and (t.tgtype & 1) = 1
    and not t.tgisinternal
), 'politicas HH usan fence por fila');

select ok(exists (
  select 1
  from pg_trigger t
  where t.tgrelid = 'public.payroll_workbook_conflicts'::regclass
    and t.tgname = 'payroll_source_revision_fence'
    and t.tgfoid = 'private.bump_payroll_revision_for_open_conflict()'::regprocedure
    and not t.tgisinternal
), 'conflictos usan un fence especializado del conjunto abierto');

create temporary table payroll_revision_before as
select revision
from private.payroll_source_revisions
where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid;

update public.overtime_records
set is_current = is_current
where false;

select is(
  (select revision from private.payroll_source_revisions
   where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid),
  (select revision from payroll_revision_before),
  'un UPDATE de cero filas no invalida la aprobacion'
);

insert into public.companies (
  id, name, slug, active, legal_name, status, workspace_enabled
) values (
  '0a4c0000-0000-0000-0000-000000000099'::uuid,
  'Tenant de prueba fence', 'tenant-prueba-fence', true,
  'Tenant de prueba fence', 'ONBOARDING', false
);

insert into public.organization_units (id, company_id, code, name, unit_type)
values (
  '0a4c0000-0000-0000-0000-000000000099'::uuid,
  '0a4c0000-0000-0000-0000-000000000099'::uuid,
  'TENANT_FENCE_099', 'Unidad de otro tenant', 'AREA'
);

update public.organization_units
set name = 'Unidad de otro tenant actualizada'
where id = '0a4c0000-0000-0000-0000-000000000099'::uuid;

select is(
  (select revision from private.payroll_source_revisions
   where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid),
  (select revision from payroll_revision_before),
  'una fila de otro tenant no toca la revision ARCOTEX'
);

insert into public.reporting_periods(period_start, period_end, status)
values (date '2098-12-16', date '2099-01-15', 'OPEN');

insert into public.payroll_workbook_conflicts (
  company_id, reporting_period_id, stable_key, workera_value, rrhh_value,
  resolved_value, resolution, resolved_at, reason
) values (
  '0a4c0000-0000-0000-0000-000000000001'::uuid,
  (select id from public.reporting_periods
   where period_start = date '2098-12-16' and period_end = date '2099-01-15'),
  'resolved-history-does-not-bump', '1'::jsonb, '2'::jsonb, '2'::jsonb,
  'KEEP_RRHH', clock_timestamp(), 'resuelto durante la aceptacion'
);

select is(
  (select revision from private.payroll_source_revisions
   where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid),
  (select revision from payroll_revision_before),
  'insertar historia de conflicto ya resuelta no auto-invalida la aceptacion'
);

insert into public.payroll_workbook_conflicts (
  company_id, reporting_period_id, stable_key, workera_value, rrhh_value
) values (
  '0a4c0000-0000-0000-0000-000000000001'::uuid,
  (select id from public.reporting_periods
   where period_start = date '2098-12-16' and period_end = date '2099-01-15'),
  'open-conflict-does-bump', '1'::jsonb, '2'::jsonb
);

select cmp_ok(
  (select revision from private.payroll_source_revisions
   where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid),
  '>',
  (select revision from payroll_revision_before),
  'un conflicto abierto si invalida la revision'
);

select has_function(
  'public', 'guard_reporting_period_close_and_reopen', array[]::text[],
  'existe el guard final de estados'
);

select ok(
  pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure)
    like '%old.status = ''OPEN'' and new.status = ''IN_REVIEW''%'
  and pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure)
    like '%old.status = ''READY_TO_CLOSE'' and new.status in (''IN_REVIEW'', ''CLOSED'')%'
  and pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure)
    like '%old.status = ''CLOSED'' and new.status = ''REOPENED''%',
  'el guard contiene una whitelist explicita de transiciones'
);

insert into public.reporting_periods(period_start, period_end, status)
values (date '2099-01-16', date '2099-02-15', 'OPEN');

select throws_ok(
  $$
    update public.reporting_periods
    set status = 'REOPENED'
    where period_start = date '2099-01-16'
      and period_end = date '2099-02-15'
  $$,
  '42501',
  'La transicion de estado OPEN -> REOPENED no esta permitida.',
  'OPEN no puede saltar directamente a REOPENED'
);

update public.reporting_periods
set status = 'IN_REVIEW'
where period_start = date '2099-01-16'
  and period_end = date '2099-02-15';

select throws_ok(
  $$
    update public.reporting_periods
    set status = 'REOPENED'
    where period_start = date '2099-01-16'
      and period_end = date '2099-02-15'
  $$,
  '42501',
  'La transicion de estado IN_REVIEW -> REOPENED no esta permitida.',
  'IN_REVIEW no puede eludir la maquina de estados'
);

select ok(
  pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure)
    like '%old.status = ''READY_TO_CLOSE''%new.status not in (''READY_TO_CLOSE'', ''CLOSED'')%reporting_period_approvals%',
  'toda salida no final desde READY invalida la aprobacion vigente'
);

select ok(
  pg_get_functiondef('public.prevent_payroll_workbook_acceptance_while_closed()'::regprocedure)
    like '%READY_TO_CLOSE%''CLOSED''%',
  'una version ACCEPTED nueva exige volver a revision'
);

select has_function(
  'private', 'require_current_payroll_approval_for_close', array[]::text[],
  'existe el guard que liga cierre con aprobacion vigente'
);

select trigger_is(
  'private', 'payroll_period_close_operations',
  'payroll_close_operation_requires_current_approval',
  'private', 'require_current_payroll_approval_for_close',
  'toda operacion de cierre exige aprobacion vigente'
);

select ok(
  pg_get_functiondef('private.require_current_payroll_approval_for_close()'::regprocedure)
    like '%accepted_workbook_version_id = new.base_version_id%source_revision = new.source_revision%invalidated_at is null%',
  'el cierre liga tenant, periodo, version y revision exactos'
);

select ok(
  pg_get_functiondef('private.bump_arcotex_payroll_source_revision()'::regprocedure)
    like '%e.company_id%v_company_id%'
  and pg_get_functiondef('private.bump_arcotex_payroll_source_revision()'::regprocedure)
    like '%employee_group_id%',
  'el fence deriva tenant por empleado o grupo y no lo hardcodea por sentencia'
);

select ok(
  not exists (
    select 1
    from pg_trigger t
    where t.tgname = 'payroll_source_revision_fence'
      and not t.tgisinternal
      and (t.tgtype & 1) = 0
  ),
  'no queda ningun fence statement-level vulnerable a cero filas'
);

select ok(
  not has_table_privilege('service_role', 'public.payroll_workbook_versions', 'INSERT')
  and not has_table_privilege('service_role', 'public.payroll_workbook_versions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.payroll_workbook_versions', 'DELETE')
  and not has_table_privilege('service_role', 'public.payroll_workbook_changes', 'INSERT')
  and not has_table_privilege('service_role', 'public.payroll_workbook_changes', 'UPDATE')
  and not has_table_privilege('service_role', 'public.payroll_workbook_changes', 'DELETE')
  and not has_table_privilege('service_role', 'public.payroll_workbook_conflicts', 'INSERT')
  and not has_table_privilege('service_role', 'public.payroll_workbook_conflicts', 'UPDATE')
  and not has_table_privilege('service_role', 'public.payroll_workbook_conflicts', 'DELETE')
  and not has_table_privilege('service_role', 'public.payroll_workbook_versions', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.payroll_workbook_changes', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.payroll_workbook_conflicts', 'TRUNCATE'),
  'service_role no dispone de un bypass DML sobre evidencia XLSX'
);

select trigger_is(
  'public', 'payroll_workbook_versions', 'payroll_workbook_versions_evidence_immutable',
  'public', 'guard_payroll_workbook_evidence_immutable',
  'versiones aceptadas/cerradas tienen guard universal de inmutabilidad'
);

select trigger_is(
  'public', 'payroll_workbook_changes', 'payroll_workbook_changes_evidence_immutable',
  'public', 'guard_payroll_workbook_evidence_immutable',
  'cambios de una version tienen guard universal de inmutabilidad'
);

select trigger_is(
  'public', 'payroll_workbook_conflicts', 'payroll_workbook_conflicts_evidence_immutable',
  'public', 'guard_payroll_workbook_evidence_immutable',
  'historia de conflictos tiene guard universal de inmutabilidad'
);

select has_function(
  'private', 'prevent_arcotex_demo_cleanup_while_closed', array[]::text[],
  'existe el guard de limpieza demo frente a periodos cerrados'
);

select trigger_is(
  'public', 'employees', 'employees_prevent_demo_cleanup_while_closed',
  'private', 'prevent_arcotex_demo_cleanup_while_closed',
  'la limpieza demo revierte antes de eliminar empleados de un periodo cerrado'
);

select ok(
  not has_table_privilege('service_role', 'public.overtime_decisions', 'INSERT')
  and not has_table_privilege('service_role', 'public.overtime_decisions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.overtime_decisions', 'DELETE')
  and not has_table_privilege('service_role', 'public.late_arrival_decisions', 'INSERT')
  and not has_table_privilege('service_role', 'public.late_arrival_decisions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.late_arrival_decisions', 'DELETE')
  and not has_table_privilege('service_role', 'public.early_departure_decisions', 'INSERT')
  and not has_table_privilege('service_role', 'public.early_departure_decisions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.early_departure_decisions', 'DELETE')
  and not has_table_privilege('service_role', 'public.absence_decisions', 'INSERT')
  and not has_table_privilege('service_role', 'public.absence_decisions', 'UPDATE')
  and not has_table_privilege('service_role', 'public.absence_decisions', 'DELETE')
  and not has_table_privilege('service_role', 'public.overtime_decisions', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.late_arrival_decisions', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.early_departure_decisions', 'TRUNCATE')
  and not has_table_privilege('service_role', 'public.absence_decisions', 'TRUNCATE'),
  'service_role no puede reescribir decisiones laborales fuera de los RPC auditados'
);

select is(
  (
    select count(*)
    from pg_trigger t
    where t.tgname like '%_decisions_prevent_closed_period'
      and t.tgrelid in (
        'public.overtime_decisions'::regclass,
        'public.late_arrival_decisions'::regclass,
        'public.early_departure_decisions'::regclass,
        'public.absence_decisions'::regclass
      )
      and (t.tgtype & 1) = 1
      and (t.tgtype & 2) = 2
      and (t.tgtype & 28) = 28
      and not t.tgisinternal
  ),
  4::bigint,
  'las cuatro decisiones bloquean INSERT, UPDATE y DELETE dentro de CLOSED'
);

select has_function(
  'private', 'sync_employee_group_history_from_cache', array[]::text[],
  'existe la sincronizacion canonica del cache de grupo al historial'
);

select is(
  (
    select count(*)
    from pg_trigger t
    where t.tgrelid = 'public.employees'::regclass
      and t.tgname in (
        'employees_sync_group_history_after_insert',
        'employees_sync_group_history_after_update'
      )
      and not t.tgisinternal
  ),
  2::bigint,
  'altas y cambios de grupo mantienen employee_group_assignments'
);

select ok(not exists (
  select 1
  from public.employees e
  where e.employee_group_id is not null
    and not exists (
      select 1
      from public.employee_group_assignments ega
      where ega.employee_id = e.id
        and current_date between ega.effective_from and coalesce(ega.effective_to, 'infinity'::date)
        and ega.employee_group_id = e.employee_group_id
    )
), 'el backfill deja alineado todo grupo vigente existente');

select ok(
  not has_table_privilege('authenticated', 'public.employee_group_assignments', 'INSERT')
  and not has_table_privilege('authenticated', 'public.employee_group_assignments', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.employee_group_assignments', 'DELETE')
  and not has_table_privilege('service_role', 'public.employee_group_assignments', 'INSERT')
  and not has_table_privilege('service_role', 'public.employee_group_assignments', 'UPDATE')
  and not has_table_privilege('service_role', 'public.employee_group_assignments', 'DELETE')
  and not has_table_privilege('service_role', 'public.employee_group_assignments', 'TRUNCATE'),
  'ningun cliente puede desalinear directamente el historial de grupo'
);

select ok(
  pg_get_functiondef('private.sync_employee_group_history_from_cache()'::regprocedure)
    like '%rp.status = ''CLOSED''%current_date between rp.period_start and rp.period_end%',
  'un cambio de grupo efectivo dentro de CLOSED exige reapertura'
);

insert into public.employee_groups (
  id, company_id, code, name
) values (
  '0a4c0000-0000-0000-0000-000000000198'::uuid,
  '0a4c0000-0000-0000-0000-000000000001'::uuid,
  'TENANT_HISTORY_099', 'Grupo histórico de prueba'
);

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id, hire_date, created_at
) values (
  '0a4c0000-0000-0000-0000-000000000199'::uuid,
  '0a4c0000-0000-0000-0000-000000000001'::uuid,
  'history-post-migration-099', 'Persona', 'Ficticia', 'Persona Ficticia',
  '0a4c0000-0000-0000-0000-000000000198'::uuid,
  current_date - 5, clock_timestamp()
);

select is(
  (
    select ega.effective_from
    from public.employee_group_assignments ega
    where ega.employee_id = '0a4c0000-0000-0000-0000-000000000199'::uuid
      and ega.employee_group_id = '0a4c0000-0000-0000-0000-000000000198'::uuid
  ),
  current_date - 5,
  'la primera asignación posterior a la migración cubre la fecha de alta histórica'
);

select has_function(
  'public', 'get_payroll_workbook_object_identity',
  array['uuid', 'date', 'date', 'text'],
  'existe la lectura service-only de identidad física del XLSX'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)',
    'EXECUTE'
  ),
  'solo el commit con identidad Storage completa cruza service_role'
);

select ok(exists (
  select 1
  from pg_trigger t
  where t.tgrelid = 'storage.objects'::regclass
    and t.tgname = 'workforce_registered_object_mutation_guard'
    and (t.tgtype & 1) = 1
    and (t.tgtype & 2) = 2
    and (t.tgtype & 28) = 28
    and not t.tgisinternal
), 'Storage serializa INSERT, UPDATE y DELETE de evidencia laboral');

select ok(not exists (
  select 1
  from pg_policies p
  where p.schemaname = 'storage'
    and p.tablename = 'objects'
    and p.policyname = 'payroll_workbooks_storage_delete_orphan_owner'
), 'authenticated no puede sustituir un XLSX huérfano entre hash y commit');

select has_function(
  'public', 'replace_attendance_correction',
  array['uuid', 'uuid', 'date', 'timestamp with time zone', 'timestamp with time zone', 'text'],
  'existe el reemplazo transaccional de correcciones'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.replace_attendance_correction(uuid,uuid,date,timestamp with time zone,timestamp with time zone,text)',
    'EXECUTE'
  )
  and not has_table_privilege('authenticated', 'public.attendance_corrections', 'INSERT')
  and not has_table_privilege('authenticated', 'public.attendance_corrections', 'UPDATE')
  and pg_get_functiondef(
    'public.replace_attendance_correction(uuid,uuid,date,timestamp with time zone,timestamp with time zone,text)'::regprocedure
  ) like '%update public.attendance_corrections%set is_current = false%insert into public.attendance_corrections%',
  'authenticated corrige solo por el RPC que reemplaza e inserta atomicamente'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.replace_system_attendance_status(uuid,uuid,uuid,date,uuid,text)',
    'EXECUTE'
  )
  and not has_table_privilege('service_role', 'public.attendance_status_records', 'INSERT')
  and not has_table_privilege('service_role', 'public.attendance_status_records', 'UPDATE')
  and pg_get_functiondef(
    'public.replace_system_attendance_status(uuid,uuid,uuid,date,uuid,text)'::regprocedure
  ) like '%max(asr.source_version)%set is_current = false%insert into public.attendance_status_records%',
  'el motor versiona códigos diarios en un único RPC idempotente'
);

select ok(
  lower(pg_get_functiondef('public.approve_medical_license(uuid,date,date)'::regprocedure))
    like '%security definer%enforce_mfa_for_privileged%payroll-source-mutation-v1%for update%'
  and lower(pg_get_functiondef('public.reject_medical_license(uuid,text)'::regprocedure))
    like '%security definer%enforce_mfa_for_privileged%payroll-source-mutation-v1%'
  and not has_table_privilege('authenticated', 'public.medical_license_approvals', 'UPDATE'),
  'licencias cambian solo por RPC con MFA, lock global y actor derivado'
);

select has_function(
  'private', 'prevent_payroll_layer_mutation_on_closed_period', array[]::text[],
  'existe el guard universal de capas temporales de pre-nomina'
);

select is(
  (
    select count(*)
    from pg_trigger t
    where t.tgname = 'payroll_closed_temporal_guard'
      and t.tgrelid in (
        'public.absence_records'::regclass,
        'public.medical_license_approvals'::regclass,
        'public.supporting_documents'::regclass,
        'public.attendance_corrections'::regclass,
        'public.attendance_status_records'::regclass,
        'public.attendance_missing_punch_flags'::regclass,
        'public.late_arrival_records'::regclass,
        'public.early_departure_records'::regclass,
        'public.overtime_records'::regclass,
        'public.employee_daily_bonuses'::regclass
      )
      and not t.tgisinternal
  ),
  10::bigint,
  'toda capa humana o derivada fechada tiene guard CLOSED'
);

select ok(
  pg_get_functiondef('private.prevent_payroll_layer_mutation_on_closed_period()'::regprocedure)
    like '%array[to_jsonb(old), to_jsonb(new)]%'
  and pg_get_functiondef('private.prevent_payroll_layer_mutation_on_closed_period()'::regprocedure)
    like '%rp.status = ''CLOSED''%',
  'el guard temporal valida OLD y NEW bajo el estado CLOSED'
);

select has_function(
  'private', 'prevent_assignment_history_change_on_closed_period', array[]::text[],
  'existe el guard de historia organizacional y de grupos'
);

select is(
  (
    select count(*)
    from pg_trigger t
    where t.tgname = 'payroll_closed_assignment_guard'
      and t.tgrelid in (
        'public.employee_group_assignments'::regclass,
        'public.employee_org_assignments'::regclass
      )
      and not t.tgisinternal
  ),
  2::bigint,
  'grupo y centro de costo histórico no cambian dentro de CLOSED'
);

select trigger_is(
  'public', 'attendance_missing_punch_flags',
  'attendance_missing_punch_flags_identity_immutable',
  'public', 'enforce_immutable_columns',
  'una alerta no puede cambiar de hecho, trabajador, fecha ni tipo'
);

select is(
  (
    select count(*)
    from pg_trigger t
    where t.tgname = 'payroll_source_revision_fence'
      and t.tgrelid in (
        'public.medical_license_approvals'::regclass,
        'public.supporting_documents'::regclass
      )
      and (t.tgtype & 1) = 1
      and not t.tgisinternal
  ),
  2::bigint,
  'licencias y documentos invalidan una aprobación viva mediante source revision'
);

select is(
  (
    select count(*)
    from pg_policies p
    where p.schemaname = 'public'
      and (p.tablename, p.policyname) in (
        ('attendance_corrections', 'attendance_corrections_insert'),
        ('attendance_status_records', 'attendance_status_records_insert'),
        ('attendance_missing_punch_flags', 'attendance_missing_punch_flags_update')
      )
      and (coalesce(p.qual, '') || coalesce(p.with_check, ''))
        like '%can_manage_employee_on_date%work_date%'
  ),
  3::bigint,
  'correcciones, codigos y flags usan autoridad historica por fecha'
);

select ok(
  not has_table_privilege('service_role', 'public.attendance_corrections', 'INSERT')
  and not has_table_privilege('service_role', 'public.attendance_corrections', 'UPDATE')
  and not has_table_privilege('service_role', 'public.attendance_corrections', 'DELETE')
  and not has_table_privilege('service_role', 'public.absence_records', 'INSERT')
  and not has_table_privilege('service_role', 'public.absence_records', 'UPDATE')
  and not has_table_privilege('service_role', 'public.absence_records', 'DELETE')
  and not has_table_privilege('service_role', 'public.attendance_missing_punch_flags', 'UPDATE')
  and not has_table_privilege('service_role', 'public.employee_daily_bonuses', 'INSERT')
  and not has_table_privilege('service_role', 'public.employee_daily_bonuses', 'DELETE')
  and not has_table_privilege('service_role', 'public.medical_license_approvals', 'UPDATE')
  and not has_table_privilege('service_role', 'public.supporting_documents', 'INSERT')
  and not has_table_privilege('service_role', 'public.supporting_documents', 'UPDATE')
  and not has_table_privilege('service_role', 'public.supporting_documents', 'DELETE')
  and not has_table_privilege('service_role', 'public.audit_log', 'UPDATE')
  and not has_table_privilege('service_role', 'public.audit_log', 'DELETE')
  and not has_table_privilege('service_role', 'public.attendance_records', 'DELETE')
  and not has_table_privilege('service_role', 'public.attendance_status_records', 'INSERT')
  and not has_table_privilege('service_role', 'public.attendance_status_records', 'UPDATE')
  and not has_table_privilege('service_role', 'public.attendance_status_records', 'DELETE')
  and not has_table_privilege('service_role', 'public.late_arrival_records', 'DELETE')
  and not has_table_privilege('service_role', 'public.early_departure_records', 'DELETE')
  and not has_table_privilege('service_role', 'public.overtime_records', 'DELETE'),
  'service_role conserva solo las escrituras operacionales indispensables'
);

select ok(not exists (
  select 1
  from unnest(array[
    'public.profiles', 'public.employee_groups', 'public.employee_group_assignments',
    'public.employees', 'public.employee_birthdays', 'public.holidays',
    'public.sync_runs', 'public.rule_engine_runs',
    'public.workera_attendance_events',
    'public.attendance_records', 'public.attendance_corrections',
    'public.attendance_statuses', 'public.attendance_status_records',
    'public.late_arrival_records', 'public.late_arrival_decisions',
    'public.early_departure_records', 'public.early_departure_decisions',
    'public.overtime_types', 'public.overtime_policies', 'public.late_arrival_policies',
    'public.overtime_records', 'public.overtime_decisions', 'public.bonus_policies',
    'public.employee_daily_bonuses', 'public.attendance_missing_punch_flags',
    'public.absence_records', 'public.absence_decisions', 'public.medical_license_approvals',
    'public.supporting_documents', 'public.audit_log',
    'public.organization_units', 'public.employee_org_assignments', 'public.work_schedules',
    'public.work_schedule_rules', 'public.schedule_assignments',
    'public.employee_time_control_policies', 'public.payroll_workbook_versions',
    'public.payroll_workbook_changes', 'public.payroll_workbook_conflicts',
    'public.reporting_periods', 'public.reporting_period_approvals',
    'private.payroll_workbook_acceptance_receipts', 'private.payroll_source_revisions',
    'private.payroll_period_close_operations',
    'private.attendance_engine_input_revisions',
    'private.attendance_engine_day_input_revisions',
    'private.workera_sync_requirements'
  ]) as protected_table(name)
  where has_table_privilege('service_role', protected_table.name, 'TRUNCATE')
), 'service_role no puede saltarse RLS y triggers mediante TRUNCATE');

select has_function(
  'private', 'prevent_employee_company_reassignment', array[]::text[],
  'existe el guard que impide reatribuir historia laboral a otro tenant'
);

select trigger_is(
  'public', 'employees', 'employees_company_is_immutable',
  'private', 'prevent_employee_company_reassignment',
  'company_id del trabajador es inmutable después del alta'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.begin_workera_sync_run(uuid,date,date,text,integer,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finish_workera_sync_run(uuid,uuid,sync_run_status,integer,integer,integer,integer,jsonb,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.upsert_workera_attendance_event(uuid,uuid,uuid,text,text,smallint,text,text,text,text,text,text,text)',
    'EXECUTE'
  ),
  'la ingesta dispone de inicio, reconciliacion y cierre RPC fenced'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.begin_attendance_rule_engine_run(uuid,date,text,uuid)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.finish_attendance_rule_engine_run(uuid,uuid,text,integer,integer,integer,integer,integer,integer,integer,text)',
    'EXECUTE'
  ),
  'el motor dispone de inicio y cierre RPC con lease exacto'
);

select ok(
  not has_table_privilege('service_role', 'public.sync_runs', 'INSERT')
  and not has_table_privilege('service_role', 'public.sync_runs', 'UPDATE')
  and not has_table_privilege('service_role', 'public.sync_runs', 'DELETE')
  and not has_table_privilege('service_role', 'public.rule_engine_runs', 'INSERT')
  and not has_table_privilege('service_role', 'public.rule_engine_runs', 'UPDATE')
  and not has_table_privilege('service_role', 'public.rule_engine_runs', 'DELETE'),
  'service_role no puede fabricar ni reescribir corridas terminales'
);

select ok(
  not has_table_privilege('service_role', 'public.workera_attendance_events', 'INSERT')
  and not has_table_privilege('service_role', 'public.workera_attendance_events', 'UPDATE')
  and not has_table_privilege('service_role', 'public.workera_attendance_events', 'DELETE')
  and not has_table_privilege('service_role', 'public.late_arrival_records', 'INSERT')
  and not has_table_privilege('service_role', 'public.late_arrival_records', 'UPDATE')
  and not has_table_privilege('service_role', 'public.early_departure_records', 'INSERT')
  and not has_table_privilege('service_role', 'public.early_departure_records', 'UPDATE')
  and not has_table_privilege('service_role', 'public.overtime_records', 'INSERT')
  and not has_table_privilege('service_role', 'public.overtime_records', 'UPDATE'),
  'eventos y candidatos calculados se publican solo por RPC atomico'
);

select has_column(
  'public', 'rule_engine_runs', 'input_revision',
  'cada corrida captura la revision global de insumos'
);

select has_column(
  'public', 'rule_engine_runs', 'day_input_revision',
  'cada corrida captura ademas la revision del dia'
);

select is(
  (
    select count(*) from pg_trigger t
    where t.tgname = 'attendance_engine_input_revision_fence'
      and not t.tgisinternal
  ),
  16::bigint,
  'los dieciseis catalogos globales del motor invalidan su revision'
);

select ok(
  exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.employee_birthdays'::regclass
      and t.tgname = 'attendance_engine_input_revision_fence'
      and not t.tgisinternal
  )
  and exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.employee_birthdays'::regclass
      and t.tgname = 'payroll_source_revision_lock'
      and not t.tgisinternal
  )
  and exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.employee_birthdays'::regclass
      and t.tgname = 'payroll_source_revision_fence'
      and not t.tgisinternal
  )
  and exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.employee_birthdays'::regclass
      and t.tgname = 'payroll_closed_temporal_guard'
      and not t.tgisinternal
  )
  and not has_table_privilege('service_role', 'public.employee_birthdays', 'INSERT')
  and not has_table_privilege('service_role', 'public.employee_birthdays', 'UPDATE')
  and not has_table_privilege('service_role', 'public.employee_birthdays', 'DELETE')
  and not has_table_privilege('service_role', 'public.employee_birthdays', 'TRUNCATE'),
  'cumpleaños invalida motor/aprobacion, queda congelado en CLOSED y no tiene bypass service_role'
);

select is(
  (
    select count(*) from pg_trigger t
    where t.tgname = 'attendance_engine_day_input_revision_fence'
      and t.tgrelid in (
        'public.workera_attendance_events'::regclass,
        'public.attendance_corrections'::regclass
      )
      and not t.tgisinternal
  ),
  2::bigint,
  'marcaciones y correcciones invalidan solo su dia'
);

select ok(
  not has_table_privilege('service_role', 'private.attendance_engine_input_revisions', 'SELECT')
  and not has_table_privilege('service_role', 'private.attendance_engine_input_revisions', 'UPDATE')
  and not has_table_privilege('service_role', 'private.attendance_engine_day_input_revisions', 'SELECT')
  and not has_table_privilege('service_role', 'private.attendance_engine_day_input_revisions', 'UPDATE')
  and not has_table_privilege('service_role', 'private.workera_sync_requirements', 'UPDATE'),
  'las revisiones y fecha de adopcion no son manipulables por la aplicacion'
);

select trigger_is(
  'public', 'employee_group_assignments', 'employee_group_assignments_tenant_guard',
  'private', 'assert_employee_group_assignment_tenant',
  'el historial de grupos impide referencias cruzadas entre tenants'
);

select ok(not exists (
  select 1
  from public.employee_group_assignments ega
  join public.employees e on e.id = ega.employee_id
  join public.employee_groups eg on eg.id = ega.employee_group_id
  where eg.company_id is distinct from e.company_id
), 'no existe historia de grupo cruzada entre empresas');

select ok(
  pg_get_functiondef('public.can_manage_employee_on_date(uuid,date)'::regprocedure)
    like '%eg.company_id = e.company_id%'
  and pg_get_functiondef('public.can_manage_employee_for_date_range(uuid,date,date)'::regprocedure)
    like '%eg.company_id = e.company_id%',
  'la autoridad historica ignora grupos ajenos al tenant'
);

select ok(
  pg_get_functiondef('private.assert_payroll_rule_engine_fresh(uuid,date,date)'::regprocedure)
    like '%v_rule.finished_at < v_sync.finished_at%'
  and pg_get_functiondef('private.assert_payroll_rule_engine_fresh(uuid,date,date)'::regprocedure)
    like '%day_input_revision is distinct from v_current_day_input_revision%'
  and pg_get_functiondef('private.assert_payroll_rule_engine_fresh(uuid,date,date)'::regprocedure)
    like '%Falta sincronizar Workera%',
  'READY exige sync y motor causalmente frescos desde la fecha de adopcion'
);

select is(
  (select required_from from private.workera_sync_requirements
   where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid),
  date '2026-08-18',
  'ARCOTEX exige sincronizacion diaria desde la adopcion Workera'
);

select ok(
  lower(pg_get_functiondef(
    'public.upsert_workera_attendance_event(uuid,uuid,uuid,text,text,smallint,text,text,text,text,text,text,text)'::regprocedure
  )) like '%timestamp crudo workera invalido o con zona horaria%'
  and pg_get_functiondef(
    'public.upsert_workera_attendance_event(uuid,uuid,uuid,text,text,smallint,text,text,text,text,text,text,text)'::regprocedure
  ) like '%YYYY-MM-DD"T"HH24:MI:SS%'
  and pg_get_functiondef(
    'public.upsert_workera_attendance_event(uuid,uuid,uuid,text,text,smallint,text,text,text,text,text,text,text)'::regprocedure
  ) like '%insert into public.workera_attendance_events (%company_id%p_company_id%',
  'el RPC rechaza timestamps invalidos y fija company_id antes del trigger diario'
);

select * from finish();
rollback;
