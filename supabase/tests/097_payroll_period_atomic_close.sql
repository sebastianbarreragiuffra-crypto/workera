-- Ejecutar únicamente sobre una instancia aislada con todas las migraciones
-- de esta rama. El desarrollo de este cambio no toca la Supabase compartida.
create extension if not exists pgtap;

begin;
select plan(43);

select has_column(
  'public', 'payroll_workbook_versions', 'source_revision',
  'cada snapshot cerrado conserva la revisión exacta de sus fuentes'
);
select has_column(
  'public', 'payroll_workbook_versions', 'close_operation_id',
  'cada snapshot cerrado conserva la operación idempotente que lo produjo'
);
select has_table(
  'private', 'payroll_source_revisions',
  'la revisión monotónica vive fuera de la API pública'
);
select has_table(
  'private', 'payroll_workbook_source_attestations',
  'la base aceptada queda atestada contra una revisión de Workera'
);
select has_table(
  'private', 'payroll_period_close_operations',
  'las reservas de cierre viven fuera de la API pública'
);

select has_function(
  'public', 'get_payroll_source_revision', array['uuid'],
  'existe la lectura acotada de revisión'
);
select has_function(
  'public', 'prepare_payroll_period_close',
  array['uuid','uuid','uuid','reporting_period_status','uuid','bigint','text','integer','text'],
  'existe la reserva autenticada del cierre'
);
select has_function(
  'public', 'abort_payroll_period_close', array['uuid'],
  'existe el aborto actor-scoped para cleanup'
);
select has_function(
  'public', 'commit_payroll_period_close', array['uuid','text','integer'],
  'existe el commit confiable del cierre'
);
select has_function(
  'public', 'register_accepted_payroll_workbook',
  array['uuid','date','date','uuid','text','integer','text','text','jsonb','bigint'],
  'la aceptación pública incluye la revisión esperada'
);

select has_trigger(
  'public', 'payroll_workbook_versions',
  'payroll_workbook_versions_no_accept_while_closed',
  'una nueva base aceptada no puede aparecer durante CLOSED'
);
select has_trigger(
  'public', 'reporting_periods', 'reporting_periods_guard_close_and_reopen',
  'el cierre y la reapertura tienen una frontera de integridad'
);
select has_trigger(
  'public', 'payroll_workbook_conflicts',
  'payroll_workbook_conflicts_no_change_while_closed',
  'los conflictos de un período cerrado permanecen inmutables'
);

-- Toda fuente toma primero un advisory BEFORE STATEMENT y solo avanza la
-- revisión en un BEFORE ROW tenant-scoped. Cero filas no invalida nada.
select is(
  (
    with expected(table_name) as (values
      ('profiles'), ('employee_groups'), ('employee_group_assignments'),
      ('employees'), ('holidays'),
      ('rule_engine_runs'), ('attendance_records'), ('attendance_corrections'),
      ('attendance_statuses'), ('attendance_status_records'),
      ('late_arrival_records'), ('late_arrival_decisions'),
      ('early_departure_records'), ('early_departure_decisions'),
      ('overtime_types'), ('overtime_policies'), ('late_arrival_policies'),
      ('overtime_records'), ('overtime_decisions'), ('bonus_policies'),
      ('employee_daily_bonuses'), ('attendance_missing_punch_flags'),
      ('absence_records'), ('absence_decisions'), ('organization_units'),
      ('employee_org_assignments'), ('work_schedules'),
      ('work_schedule_rules'), ('schedule_assignments'),
      ('employee_time_control_policies'), ('payroll_workbook_conflicts')
    )
    select count(*)::integer
    from expected e
    join pg_catalog.pg_class c on c.relname = e.table_name
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
    join pg_catalog.pg_trigger statement_lock on statement_lock.tgrelid = c.oid
      and statement_lock.tgname = 'payroll_source_revision_lock'
      and not statement_lock.tgisinternal
      and (statement_lock.tgtype & 1) = 0
      and (statement_lock.tgtype & 2) = 2
    join pg_catalog.pg_trigger row_fence on row_fence.tgrelid = c.oid
      and row_fence.tgname = 'payroll_source_revision_fence'
      and not row_fence.tgisinternal
      and (row_fence.tgtype & 1) = 1
      and (row_fence.tgtype & 2) = 2
  ),
  31,
  'las 31 superficies toman lock statement-level y fence tenant-scoped por fila'
);

select ok(
  lower(pg_get_functiondef('private.bump_arcotex_payroll_source_revision()'::regprocedure))
    like '%perform private.advance_arcotex_payroll_source_revision(v_company_id)%'
  and lower(pg_get_functiondef('private.advance_arcotex_payroll_source_revision(uuid)'::regprocedure))
    like '%on conflict (company_id) do update%revision = source_revision.revision + 1%',
  'el fence deriva tenant y avanza una revisión monotónica'
);

create temporary table payroll_close_revision_before(revision bigint not null);
insert into payroll_close_revision_before
select revision
from private.payroll_source_revisions
where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid;
insert into public.holidays(holiday_date, name)
values (date '2098-12-25', 'Fixture fence cierre');
select is(
  (
    select revision
    from private.payroll_source_revisions
    where company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
  ),
  (select revision + 1 from payroll_close_revision_before),
  'una mutación real de fuente incrementa la revisión en la misma transacción'
);

select ok(
  lower(pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb,bigint)'::regprocedure
  )) like '%for update%p_expected_source_revision%'
  and lower(pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb,bigint)'::regprocedure
  )) like '%private.payroll_workbook_source_attestations%'
  and lower(pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb,bigint)'::regprocedure
  )) like '%select r.revision into v_current_revision%insert into private.payroll_workbook_source_attestations%',
  'la aceptación bloquea, re-lee tras sus escrituras y atesta la revisión resultante'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb,bigint)',
    'EXECUTE'
  ),
  'la sesión no puede usar ninguno de los wrappers internos de aceptación'
);

select ok(
  lower(pg_get_functiondef('public.get_payroll_source_revision(uuid)'::regprocedure))
    like '%has_company_app_role(p_company_id, ''admin_rrhh''%'
  and lower(pg_get_functiondef('public.get_payroll_source_revision(uuid)'::regprocedure))
    not like '%current_user_role()%'
  and lower(pg_get_functiondef('public.get_payroll_source_revision(uuid)'::regprocedure))
    not like '%is_active_company_member(p_company_id)%'
  and has_function_privilege(
    'authenticated', 'public.get_payroll_source_revision(uuid)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.get_payroll_source_revision(uuid)', 'EXECUTE'
  ),
  'solo RR. HH. miembro de la empresa puede leer la revisión'
);

select ok(
  (select p.prosecdef and p.provolatile = 'v'
   from pg_catalog.pg_proc p
   where p.oid = (
     'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'
   )::regprocedure),
  'prepare es SECURITY DEFINER y VOLATILE'
);
select ok(
  lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%has_company_app_role(p_company_id, ''admin_rrhh''%'
  and lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) not like '%current_user_role()%'
  and lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) not like '%is_active_company_member(p_company_id)%'
  and lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%enforce_mfa_for_privileged()%',
  'prepare deriva ADMIN_RRHH, empresa activa y MFA desde la sesión'
);
select ok(
  lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%p_expected_status is distinct from ''ready_to_close''%'
  and lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%period_end <> (date_trunc%'
  and lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%/closed/%p_operation_id%',
  'prepare exige READY_TO_CLOSE, corte 16-15 y ruta exacta de operación'
);
select ok(
  lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%private.payroll_source_revisions%for update%'
  and lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%pg_advisory_xact_lock%'
  and lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%from public.reporting_periods rp%for update%',
  'prepare serializa revisión, aceptación y estado del período'
);
select ok(
  lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%v_latest is distinct from p_expected_base_version_id%'
  and lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%private.payroll_workbook_source_attestations%'
  and lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'::regprocedure
  )) like '%payroll_workbook_conflicts%resolved_at is null%',
  'prepare revalida última ACCEPTED vigente y bloquea conflictos abiertos'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)',
    'EXECUTE'
  ),
  'solo una sesión autenticada puede intentar preparar y queda sujeta a los gates internos'
);

select ok(
  (select p.prosecdef and p.provolatile = 'v'
   from pg_catalog.pg_proc p
   where p.oid = 'public.commit_payroll_period_close(uuid,text,integer)'::regprocedure),
  'commit es SECURITY DEFINER y VOLATILE'
);
select ok(
  has_function_privilege(
    'service_role', 'public.commit_payroll_period_close(uuid,text,integer)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated', 'public.commit_payroll_period_close(uuid,text,integer)', 'EXECUTE'
  )
  and not has_function_privilege(
    'anon', 'public.commit_payroll_period_close(uuid,text,integer)', 'EXECUTE'
  ),
  'solo service_role puede entregar la atestación de bytes reales'
);
select ok(
  lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%auth.role() is distinct from ''service_role''%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%p_verified_content_sha256 is distinct from v_operation.content_sha256%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%p_verified_file_size is distinct from v_operation.file_size%',
  'commit acepta solo el hash y tamaño recalculados por la frontera confiable'
);
select ok(
  lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%from private.payroll_period_close_operations o%for update%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%v_operation.status = ''committed''%return v_operation.snapshot_version_id%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%v_operation.expires_at <= statement_timestamp()%v_operation.mfa_aal <> ''aal2''%',
  'la operación se bloquea, vence y recupera idempotentemente un commit ya realizado'
);
select ok(
  lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%join public.company_memberships%cm.active%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%join public.company_membership_roles cmr%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%cmr.company_id = cm.company_id%cmr.membership_id = cm.id%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%join public.company_roles cr%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%cr.company_id = cmr.company_id%cr.id = cmr.role_id%cr.active%cr.base_role = ''admin_rrhh''%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    not like '%p.role = ''admin_rrhh''%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%c.status = ''active''%c.workspace_enabled%',
  'commit vuelve a autorizar actor, rol, membresía y empresa bajo transacción'
);
select ok(
  lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%private.payroll_source_revisions%for update%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%pg_advisory_xact_lock%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%v_period.status is distinct from v_operation.expected_status%',
  'commit vuelve a fijar revisión, aceptación y estado esperado'
);
select ok(
  lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%private.payroll_workbook_source_attestations%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%v_latest is distinct from v_operation.base_version_id%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%payroll_workbook_conflicts%resolved_at is null%',
  'commit rechaza una base obsoleta o conflictos persistidos abiertos'
);
select ok(
  lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%from storage.objects o%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%o.owner_id = v_operation.actor_id::text%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%o.metadata ->> ''mimetype''%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%o.user_metadata ->> ''operation_id'' = v_operation.id::text%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%o.user_metadata ->> ''source_revision'' = v_current_revision::text%',
  'commit liga objeto privado, dueño, MIME, operación y revisión'
);
select ok(
  lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%insert into public.payroll_workbook_versions%''closed_snapshot''%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%update public.reporting_periods%set status = ''closed''%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%insert into public.audit_log%reporting_period.closed_with_payroll_snapshot%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%update private.payroll_period_close_operations%set status = ''committed''%',
  'snapshot, CLOSED, audit_log y estado COMMITTED pertenecen al mismo RPC transaccional'
);
select ok(
  lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%accepted_base_sha256%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%snapshot_content_sha256%'
  and lower(pg_get_functiondef('public.commit_payroll_period_close(uuid,text,integer)'::regprocedure))
    like '%canonical_closed_with_accepted_adjustments%',
  'la auditoría distingue la base exacta ACCEPTED del nuevo libro canónico CLOSED_SNAPSHOT'
);

select ok(
  (select lower(p.with_check::text) like '%ready_to_close%'
      and lower(p.with_check::text) like '%closed%'
   from pg_catalog.pg_policies p
   where p.schemaname = 'public'
     and p.tablename = 'reporting_periods'
     and p.policyname = 'reporting_periods_update_admin'),
  'RLS impide el cierre directo incluso a ADMIN_RRHH'
);

insert into public.reporting_periods(period_start, period_end, status)
values (date '2098-02-16', date '2098-03-15', 'OPEN');
select throws_ok(
  $$
    update public.reporting_periods
    set status = 'CLOSED'
    where period_start = date '2098-02-16'
      and period_end = date '2098-03-15'
  $$,
  '42501',
  null,
  'el trigger rechaza conductualmente un cierre que no trae operación preparada'
);

select ok(
  lower(pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure))
    like '%old.status = ''closed''%new.status <> ''reopened''%'
  and lower(pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure))
    like '%new.reopened_by is distinct from auth.uid()%'
  and lower(pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure))
    like '%new.reopen_reason%'
  and lower(pg_get_functiondef('public.guard_reporting_period_close_and_reopen()'::regprocedure))
    like '%new.closed_at is distinct from old.closed_at%',
  'reabrir exige actor, instante y motivo sin alterar la evidencia histórica del cierre'
);
select ok(
  (select p.cmd = 'DELETE'
      and lower(p.qual::text) like '%owner_id = (auth.uid())::text%'
      and lower(p.qual::text) like '%payroll_workbook_versions%'
      and lower(p.qual::text) like '%payroll_period_close_operations%status = ''prepared''%'
   from pg_catalog.pg_policies p
   where p.schemaname = 'storage'
     and p.tablename = 'objects'
     and p.policyname = 'payroll_workbooks_storage_delete_orphan_owner'),
  'cleanup solo borra un objeto propio, huérfano y sin reserva vigente'
);
select ok(
  (select not i.indisunique
      and pg_get_expr(i.indpred, i.indrelid) like '%status = ''ACCEPTED''%'
   from pg_catalog.pg_index i
   join pg_catalog.pg_class idx on idx.oid = i.indexrelid
   join pg_catalog.pg_class tbl on tbl.oid = i.indrelid
   join pg_catalog.pg_namespace ns on ns.oid = tbl.relnamespace
   where ns.nspname = 'public'
     and tbl.relname = 'payroll_workbook_versions'
     and idx.relname = 'payroll_workbook_versions_accepted_hash_idx'),
  'el hash queda indexado pero la idempotencia depende del comando completo'
);
select ok(
  not exists (
    select 1
    from pg_catalog.pg_constraint c
    where c.conrelid = 'public.payroll_workbook_versions'::regclass
      and c.contype = 'u'
      and pg_get_constraintdef(c.oid)
        like 'UNIQUE% (company_id, reporting_period_id, content_sha256)%'
  ),
  'una reapertura puede producir otro cierre histórico con bytes idénticos'
);
select ok(
  (select pg_get_constraintdef(c.oid) like '%status = ''COMMITTED''%committed_at IS NOT NULL%snapshot_version_id IS NOT NULL%'
      and pg_get_constraintdef(c.oid) like '%committed_at IS NULL%snapshot_version_id IS NULL%'
   from pg_catalog.pg_constraint c
   where c.conrelid = 'private.payroll_period_close_operations'::regclass
     and c.conname = 'payroll_period_close_operations_state_evidence_chk'),
  'PREPARED/ABORTED nunca pueden fingir la evidencia de una operación COMMITTED'
);
select ok(
  lower(pg_get_functiondef('public.prevent_payroll_workbook_acceptance_while_closed()'::regprocedure))
    like '%new.status = ''accepted''%v_period_status in (''ready_to_close'', ''closed'')%',
  'una versión nueva exige revisión y CLOSED preserva su snapshot exacto'
);

select * from finish();
rollback;
