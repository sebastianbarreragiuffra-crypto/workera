-- Integridad final del fence de pre-nomina y de la maquina de estados.
--
-- La primera version del fence era FOR EACH STATEMENT y estaba fijada a
-- ARCOTEX. Por eso un UPDATE que no tocaba filas, o una escritura real de
-- otro tenant, podia invalidar una aprobacion de ARCOTEX. Ademas, el registro
-- interno de un conflicto ya resuelto avanzaba la revision durante la propia
-- aceptacion del XLSX. Esta migracion deja el fence antes de cada cambio real,
-- deriva el tenant desde la fila y separa el conjunto de conflictos abiertos
-- de su historia ya resuelta.

-- La idempotencia pertenece al comando completo (actor, razon, cambios, base,
-- revision y bytes), no solo al hash del archivo. Dos comandos distintos con
-- bytes iguales no pueden compartir silenciosamente una decision. El recibo
-- privado de 1800 es la unica clave idempotente.
drop index if exists public.payroll_workbook_versions_accepted_hash_uniq;
create index if not exists payroll_workbook_versions_accepted_hash_idx
  on public.payroll_workbook_versions(company_id, reporting_period_id, content_sha256)
  where status = 'ACCEPTED';

-- TRUNCATE no ejecuta triggers por fila ni pasa por RLS. Supabase concede
-- esta capacidad a service_role por defecto, por lo que debe retirarse de
-- toda fuente, decisión y evidencia que participa en la pre-nómina.
revoke truncate on table
  public.profiles,
  public.employee_groups,
  public.employee_group_assignments,
  public.employees,
  public.employee_birthdays,
  public.holidays,
  public.sync_runs,
  public.rule_engine_runs,
  public.workera_attendance_events,
  public.attendance_records,
  public.attendance_corrections,
  public.attendance_statuses,
  public.attendance_status_records,
  public.late_arrival_records,
  public.late_arrival_decisions,
  public.early_departure_records,
  public.early_departure_decisions,
  public.overtime_types,
  public.overtime_policies,
  public.late_arrival_policies,
  public.overtime_records,
  public.overtime_decisions,
  public.bonus_policies,
  public.employee_daily_bonuses,
  public.attendance_missing_punch_flags,
  public.absence_records,
  public.absence_decisions,
  public.medical_license_approvals,
  public.supporting_documents,
  public.audit_log,
  public.organization_units,
  public.employee_org_assignments,
  public.work_schedules,
  public.work_schedule_rules,
  public.schedule_assignments,
  public.employee_time_control_policies,
  public.payroll_workbook_versions,
  public.payroll_workbook_changes,
  public.payroll_workbook_conflicts,
  public.reporting_periods,
  public.reporting_period_approvals,
  private.payroll_workbook_acceptance_receipts,
  private.payroll_source_revisions,
  private.payroll_period_close_operations
from authenticated, service_role;

-- TRUNCATE salta por completo los triggers de objetos y destruiría de una
-- vez la referencia física de toda evidencia privada.
revoke truncate on table storage.objects from authenticated, service_role;

-- Las capabilities con service_role no reciben una via DML lateral. Los RPC
-- SECURITY DEFINER siguen escribiendo como su owner, pero ningun cliente
-- privilegiado puede alterar evidencia saltandose hash, actor o revision.
revoke insert, update, delete on public.payroll_workbook_versions from service_role;
revoke insert, update, delete on public.payroll_workbook_changes from service_role;
revoke insert, update, delete on public.payroll_workbook_conflicts from service_role;
revoke insert, update, delete on public.overtime_decisions from service_role;
revoke insert, update, delete on public.late_arrival_decisions from service_role;
revoke insert, update, delete on public.early_departure_decisions from service_role;
revoke insert, update, delete on public.absence_decisions from service_role;
revoke insert, update, delete on public.attendance_corrections from service_role;
revoke insert, update, delete on public.absence_records from service_role;
revoke insert, update, delete on public.attendance_missing_punch_flags from service_role;
revoke insert, update, delete on public.employee_daily_bonuses from service_role;
revoke insert, update, delete on public.medical_license_approvals from service_role;
revoke insert, update, delete on public.supporting_documents from service_role;
revoke update, delete on public.audit_log from service_role;
revoke update on public.supporting_documents from authenticated;
revoke insert, update, delete on public.attendance_records from service_role;
revoke delete on public.attendance_status_records from service_role;
revoke delete on public.late_arrival_records from service_role;
revoke delete on public.early_departure_records from service_role;
revoke delete on public.overtime_records from service_role;

-- El bucket guarda evidencia laboral que sigue siendo obligatoria aun cuando
-- un cliente use service_role (rol que evita RLS). Una sesión autenticada no
-- puede borrar un huérfano: de otro modo podría sustituir los bytes entre la
-- verificación del servidor y el commit. La limpieza queda exclusivamente en
-- capabilities server-only, siempre serializada por este mismo guard.
drop policy if exists payroll_workbooks_storage_delete_orphan_owner
  on storage.objects;

create or replace function private.prevent_registered_workforce_object_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_bucket text;
  v_old_name text;
  v_new_bucket text;
  v_new_name text;
begin
  if tg_op <> 'INSERT' then
    v_old_bucket := old.bucket_id;
    v_old_name := old.name;
  end if;
  if tg_op <> 'DELETE' then
    v_new_bucket := new.bucket_id;
    v_new_name := new.name;
  end if;
  if coalesce(v_old_bucket, '') not in ('supporting-documents', 'payroll-workbooks')
     and coalesce(v_new_bucket, '') not in ('supporting-documents', 'payroll-workbooks') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- Serializa la mutación física con aceptación, cierre y fences de fuentes.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if (
    v_old_bucket = 'supporting-documents'
    and exists (
      select 1
      from public.supporting_documents d
      where d.storage_path = v_old_name
    )
  ) or (
    v_old_bucket = 'payroll-workbooks'
    and (
      exists (
        select 1
        from public.payroll_workbook_versions v
        where v.storage_path = v_old_name
      )
      or exists (
        select 1
        from private.payroll_period_close_operations o
        where o.storage_path = v_old_name
          and o.status = 'PREPARED'
          and o.expires_at > pg_catalog.statement_timestamp()
      )
    )
  ) then
    raise exception 'No se puede alterar evidencia laboral registrada.'
      using errcode = '42501';
  end if;

  -- También bloquea mover/reemplazar un huérfano hacia la ruta lógica de una
  -- evidencia registrada que esté temporalmente sin objeto.
  if tg_op in ('INSERT', 'UPDATE') and (
    (
      v_new_bucket = 'supporting-documents'
      and exists (
        select 1
        from public.supporting_documents d
        where d.storage_path = v_new_name
      )
    )
    or (
      v_new_bucket = 'payroll-workbooks'
      and (
        exists (
          select 1
          from public.payroll_workbook_versions v
          where v.storage_path = v_new_name
        )
        or exists (
          select 1
          from private.payroll_period_close_operations o
          where o.storage_path = v_new_name
            and o.status = 'PREPARED'
            and o.expires_at > pg_catalog.statement_timestamp()
        )
      )
    )
  ) then
    raise exception 'No se puede mover un objeto sobre evidencia laboral registrada.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function private.prevent_registered_workforce_object_mutation() is
  'Serializa INSERT/UPDATE/DELETE e impide que incluso service_role borre, reemplace o recree bytes de evidencia laboral registrada.';

drop trigger if exists workforce_registered_object_mutation_guard
  on storage.objects;
create trigger workforce_registered_object_mutation_guard
before insert or update or delete on storage.objects
for each row execute function private.prevent_registered_workforce_object_mutation();

-- La descarga HTTP no comparte una transacción con PostgreSQL. Para ligar los
-- bytes recalculados al objeto exacto se lee su identidad antes y después de
-- descargar, y el commit la vuelve a comprobar bajo el mismo advisory que el
-- trigger de Storage. Un DELETE+INSERT o un upsert cambia id/version/updated_at
-- y nunca puede quedar registrado con la huella de los bytes anteriores.
create or replace function public.get_payroll_workbook_object_identity(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_storage_path text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_identity jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'La atestación física del XLSX pertenece al servicio de pre-nómina.'
      using errcode = '42501';
  end if;
  if p_company_id is null
     or p_period_start is null
     or p_period_end is null
     or p_storage_path is null
     or p_storage_path not like (
       p_company_id::text || '/' || p_period_start::text || '_' ||
       p_period_end::text || '/%.xlsx'
     ) then
    raise exception 'La ruta del XLSX no corresponde a empresa y período.'
      using errcode = '22023';
  end if;

  select pg_catalog.jsonb_build_object(
    'objectId', o.id::text,
    'version', o.version,
    'updatedAt', o.updated_at
  )
    into v_identity
  from storage.objects o
  where o.bucket_id = 'payroll-workbooks'
    and o.name = p_storage_path
    and o.id is not null
    and o.updated_at is not null;

  if v_identity is null then
    raise exception 'El XLSX privado no existe o carece de identidad verificable.'
      using errcode = '55000';
  end if;
  return v_identity;
end;
$$;

revoke all on function public.get_payroll_workbook_object_identity(
  uuid, date, date, text
) from public, anon, authenticated, service_role;
grant execute on function public.get_payroll_workbook_object_identity(
  uuid, date, date, text
) to service_role;

create or replace function public.register_accepted_payroll_workbook(
  p_actor_id uuid,
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_expected_base_version_id uuid,
  p_content_sha256 text,
  p_file_size integer,
  p_storage_path text,
  p_general_reason text,
  p_changes jsonb,
  p_expected_source_revision bigint,
  p_verified_content_sha256 text,
  p_verified_file_size integer,
  p_idempotency_key text,
  p_storage_object_id uuid,
  p_storage_object_version text,
  p_storage_object_updated_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'La aceptación atestada pertenece al servicio de pre-nómina.'
      using errcode = '42501';
  end if;
  if p_storage_object_id is null or p_storage_object_updated_at is null then
    raise exception 'La identidad física del XLSX es obligatoria.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform 1
  from storage.objects o
  where o.bucket_id = 'payroll-workbooks'
    and o.name = p_storage_path
    and o.id = p_storage_object_id
    and o.version is not distinct from p_storage_object_version
    and o.updated_at = p_storage_object_updated_at;
  if not found then
    raise exception 'El objeto XLSX cambió después de verificar sus bytes.'
      using errcode = '55000';
  end if;

  return public.register_accepted_payroll_workbook(
    p_actor_id,
    p_company_id,
    p_period_start,
    p_period_end,
    p_expected_base_version_id,
    p_content_sha256,
    p_file_size,
    p_storage_path,
    p_general_reason,
    p_changes,
    p_expected_source_revision,
    p_verified_content_sha256,
    p_verified_file_size,
    p_idempotency_key
  );
end;
$$;

-- El overload anterior ya no es una capability invocable. Solo el wrapper
-- con identidad física completa puede cruzar la frontera service_role.
revoke all on function public.register_accepted_payroll_workbook(
  uuid, uuid, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text
) from public, anon, authenticated, service_role;
revoke all on function public.register_accepted_payroll_workbook(
  uuid, uuid, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text, uuid, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.register_accepted_payroll_workbook(
  uuid, uuid, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text, uuid, text, timestamptz
) to service_role;

comment on function public.register_accepted_payroll_workbook(
  uuid, uuid, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text, uuid, text, timestamptz
) is 'Commit service_role-only que liga hash y tamaño recalculados a la identidad inmutable del objeto Storage bajo advisory.';

create or replace function private.prevent_workforce_storage_truncate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'TRUNCATE de Storage está deshabilitado para proteger evidencia laboral.'
    using errcode = '42501';
end;
$$;

drop trigger if exists workforce_storage_truncate_guard on storage.objects;
create trigger workforce_storage_truncate_guard
before truncate on storage.objects
for each statement execute function private.prevent_workforce_storage_truncate();

-- El RPC histórico validaba Storage y recién después iniciaba el INSERT de
-- metadata. Se conserva su implementación auditada detrás de un wrapper que
-- toma primero el mismo advisory del guard físico; así no existe una ventana
-- para borrar o reemplazar el objeto entre validación y registro.
alter function public.register_supporting_document_upload(
  uuid, text, text, uuid, uuid, uuid
) rename to register_supporting_document_upload_locked_impl;
alter function public.register_supporting_document_upload_locked_impl(
  uuid, text, text, uuid, uuid, uuid
) set schema private;
revoke all on function private.register_supporting_document_upload_locked_impl(
  uuid, text, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create function public.register_supporting_document_upload(
  p_intent_id uuid,
  p_document_type text,
  p_original_filename text,
  p_absence_record_id uuid default null,
  p_late_arrival_decision_id uuid default null,
  p_early_departure_record_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  return private.register_supporting_document_upload_locked_impl(
    p_intent_id,
    p_document_type,
    p_original_filename,
    p_absence_record_id,
    p_late_arrival_decision_id,
    p_early_departure_record_id
  );
end;
$$;

revoke all on function public.register_supporting_document_upload(
  uuid, text, text, uuid, uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.register_supporting_document_upload(
  uuid, text, text, uuid, uuid, uuid
) to authenticated;
revoke insert, update, delete on public.supporting_documents from authenticated;

-- La aprobación/rechazo médico nunca se compone con UPDATE directo: ambos
-- RPC validan actor, rol y MFA, y proyectan el código L dentro de la misma
-- transacción. SECURITY DEFINER permite retirar el privilegio de tabla a la
-- sesión sin romper el flujo canónico.
create or replace function public.approve_medical_license(
  p_approval_id uuid,
  p_confirmed_start_date date,
  p_confirmed_end_date date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_absence_record_id uuid;
  v_employee_id uuid;
  v_company_id uuid;
  v_l_status_id uuid;
  v_date date;
  v_current_id uuid;
  v_next_version integer;
  v_max_days constant integer := 366;
begin
  if not coalesce(public.is_medical_license_approver(), false) then
    raise exception 'No autorizado para aprobar licencias médicas.';
  end if;
  perform public.enforce_mfa_for_privileged();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  if p_confirmed_start_date is null or p_confirmed_end_date is null then
    raise exception 'Las fechas confirmadas son obligatorias.';
  end if;
  if p_confirmed_end_date < p_confirmed_start_date then
    raise exception 'La fecha de término no puede ser anterior a la fecha de inicio.';
  end if;
  if (p_confirmed_end_date - p_confirmed_start_date) + 1 > v_max_days then
    raise exception
      'El rango confirmado (% días) supera el máximo de % días para una licencia médica.',
      (p_confirmed_end_date - p_confirmed_start_date) + 1, v_max_days;
  end if;

  select mla.absence_record_id
    into v_absence_record_id
  from public.medical_license_approvals mla
  where mla.id = p_approval_id
    and mla.status = 'PENDING_RRHH_APPROVAL'
  for update;
  if v_absence_record_id is null then
    raise exception 'La licencia no existe o ya no está pendiente de aprobación.';
  end if;

  select ar.employee_id, e.company_id into v_employee_id, v_company_id
  from public.absence_records ar
  join public.employees e on e.id = ar.employee_id
  where ar.id = v_absence_record_id;
  if not coalesce(public.has_company_app_role(v_company_id, 'ADMIN_RRHH'), false)
     or not coalesce(public.has_company_permission(v_company_id, 'licenses.approve'), false) then
    raise exception 'No autorizado para aprobar licencias médicas de esta empresa.'
      using errcode = '42501';
  end if;
  select ats.id into v_l_status_id
  from public.attendance_statuses ats
  where ats.code = 'L';
  if v_l_status_id is null then
    raise exception 'No se encontró el código de asistencia "L" en el catálogo.';
  end if;

  v_date := p_confirmed_start_date;
  while v_date <= p_confirmed_end_date loop
    select asr.id
      into v_current_id
    from public.attendance_status_records asr
    where asr.employee_id = v_employee_id
      and asr.work_date = v_date
      and asr.is_current
    for update;

    if v_current_id is not null then
      update public.attendance_status_records
      set is_current = false
      where id = v_current_id;
    end if;

    select coalesce(pg_catalog.max(asr.source_version), 0) + 1
      into v_next_version
    from public.attendance_status_records asr
    where asr.employee_id = v_employee_id
      and asr.work_date = v_date;

    insert into public.attendance_status_records (
      employee_id, work_date, attendance_status_id, source, source_hash,
      source_version, created_by, reason
    ) values (
      v_employee_id, v_date, v_l_status_id, 'manual',
      pg_catalog.md5(v_employee_id::text || '|' || v_date::text || '|L|' || p_approval_id::text),
      v_next_version,
      v_actor_id,
      'Licencia médica aprobada'
    );

    v_current_id := null;
    v_next_version := null;
    v_date := v_date + 1;
  end loop;

  update public.medical_license_approvals
  set status = 'APPROVED',
      approved_by = v_actor_id,
      approved_at = pg_catalog.now(),
      confirmed_start_date = p_confirmed_start_date,
      confirmed_end_date = p_confirmed_end_date
  where id = p_approval_id;
end;
$$;

create or replace function public.reject_medical_license(
  p_approval_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
begin
  if not coalesce(public.is_medical_license_approver(), false) then
    raise exception 'No autorizado para rechazar licencias médicas.';
  end if;
  perform public.enforce_mfa_for_privileged();
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  if nullif(pg_catalog.btrim(p_reason), '') is null then
    raise exception 'El motivo de rechazo es obligatorio.';
  end if;

  select e.company_id
    into v_company_id
  from public.medical_license_approvals mla
  join public.absence_records ar on ar.id = mla.absence_record_id
  join public.employees e on e.id = ar.employee_id
  where mla.id = p_approval_id
    and mla.status = 'PENDING_RRHH_APPROVAL'
  for update of mla;

  if v_company_id is null then
    raise exception 'La licencia no existe o ya no está pendiente de aprobación.';
  end if;
  if not coalesce(public.has_company_app_role(v_company_id, 'ADMIN_RRHH'), false)
     or not coalesce(public.has_company_permission(v_company_id, 'licenses.approve'), false) then
    raise exception 'No autorizado para rechazar licencias médicas de esta empresa.'
      using errcode = '42501';
  end if;

  update public.medical_license_approvals
  set status = 'REJECTED',
      rejected_by = v_actor_id,
      rejected_at = pg_catalog.now(),
      rejection_reason = pg_catalog.btrim(p_reason)
  where id = p_approval_id
    and status = 'PENDING_RRHH_APPROVAL';

  if not found then
    raise exception 'La licencia no existe o ya no está pendiente de aprobación.';
  end if;
end;
$$;

revoke all on function public.approve_medical_license(uuid, date, date)
  from public, anon, authenticated, service_role;
revoke all on function public.reject_medical_license(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_medical_license(uuid, date, date)
  to authenticated;
grant execute on function public.reject_medical_license(uuid, text)
  to authenticated;
revoke insert, update, delete on public.medical_license_approvals
  from authenticated;

-- Una correccion vigente se reemplaza como una sola transaccion. La version
-- anterior nunca se desactiva desde el navegador antes de saber si la nueva
-- fila pudo insertarse: cualquier constraint/trigger que falle revierte ambas
-- operaciones. El RPC tampoco confia en employee_id/work_date redundantes ni
-- en el autor entregado por el cliente.
create or replace function public.replace_attendance_correction(
  p_attendance_record_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_corrected_clock_in timestamptz,
  p_corrected_clock_out timestamptz,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_current_id uuid;
  v_new_id uuid;
begin
  if v_actor_id is null then
    raise exception 'Debes iniciar sesion para corregir una marcacion.'
      using errcode = '42501';
  end if;
  if p_corrected_clock_in is null and p_corrected_clock_out is null then
    raise exception 'Ingresa al menos una de las dos horas.'
      using errcode = '22023';
  end if;
  if nullif(pg_catalog.btrim(p_reason), '') is null then
    raise exception 'El motivo de la correccion es obligatorio.'
      using errcode = '22023';
  end if;

  -- Mismo orden global -> hecho usado por cierre, aceptacion y decisiones HE.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  if exists (
    select 1
    from public.rule_engine_runs r
    join public.attendance_records ar
      on ar.employee_id = p_employee_id and ar.work_date = p_work_date
    join public.employees e on e.id = ar.employee_id
    where r.company_id = e.company_id
      and r.work_date = p_work_date
      and r.status = 'RUNNING'
  ) then
    raise exception 'Hay un recálculo en curso para esta fecha; reintenta al finalizar.'
      using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_attendance_record_id::text, 2)
  );

  select e.company_id
    into v_company_id
  from public.attendance_records ar
  join public.employees e on e.id = ar.employee_id
  where ar.id = p_attendance_record_id
    and ar.employee_id = p_employee_id
    and ar.work_date = p_work_date
    and ar.is_current
  for update of ar;

  if v_company_id is null then
    raise exception 'La marcacion no coincide con el trabajador y fecha indicados.'
      using errcode = '22023';
  end if;
  if not coalesce(
    public.can_manage_employee_on_date(p_employee_id, p_work_date),
    false
  ) then
    raise exception 'No tienes permiso para corregir esta marcacion.'
      using errcode = '42501';
  end if;

  select ac.id
    into v_current_id
  from public.attendance_corrections ac
  where ac.attendance_record_id = p_attendance_record_id
    and ac.is_current
  for update;

  if v_current_id is not null then
    if not coalesce(
      public.has_company_app_role(v_company_id, 'ADMIN_RRHH'),
      false
    ) then
      raise exception 'Solo RR. HH. puede reemplazar una correccion vigente.'
        using errcode = '42501';
    end if;

    update public.attendance_corrections
    set is_current = false
    where id = v_current_id;
  end if;

  insert into public.attendance_corrections (
    attendance_record_id,
    employee_id,
    work_date,
    corrected_clock_in,
    corrected_clock_out,
    reason,
    corrected_by
  ) values (
    p_attendance_record_id,
    p_employee_id,
    p_work_date,
    p_corrected_clock_in,
    p_corrected_clock_out,
    pg_catalog.btrim(p_reason),
    v_actor_id
  )
  returning id into v_new_id;

  -- La corrección y su señal de derivación pendiente son indivisibles. Si el
  -- proceso de aplicación cae antes de abrir el rerun, el último estado del
  -- día queda FAILED y el export/cierre no puede reutilizar una corrida vieja.
  insert into public.rule_engine_runs (
    company_id,
    work_date,
    status,
    triggered_by,
    started_at,
    finished_at,
    failure_count,
    error_summary,
    triggered_by_profile
  ) values (
    v_company_id,
    p_work_date,
    'FAILED',
    'MANUAL',
    clock_timestamp(),
    clock_timestamp(),
    1,
    'Corrección guardada; recálculo pendiente.',
    v_actor_id
  );

  return v_new_id;
end;
$$;

comment on function public.replace_attendance_correction(
  uuid, uuid, date, timestamptz, timestamptz, text
) is
  'Registra o reemplaza atomicamente una correccion, deriva el actor de la sesion, valida hecho/empleado/fecha y conserva todo el historial.';

revoke all on function public.replace_attendance_correction(
  uuid, uuid, date, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.replace_attendance_correction(
  uuid, uuid, date, timestamptz, timestamptz, text
) to authenticated;

-- Las sesiones solo pueden escribir por el RPC atomico anterior. Las policies
-- quedan como defensa adicional para la sentencia interna del RPC.
revoke insert, update, delete on public.attendance_corrections from authenticated;

-- El motor reemplaza P/? con un solo commit idempotente. El RPC serializa por
-- empresa y por trabajador/fecha, respeta cualquier fila humana/Workera y
-- calcula la siguiente versión desde todo el historial; una respuesta de red
-- perdida se puede reintentar sin dejar el día sin fila vigente.
create or replace function public.replace_system_attendance_status(
  p_company_id uuid,
  p_rule_engine_run_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_attendance_status_id uuid,
  p_source_hash text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_id uuid;
  v_current_status_id uuid;
  v_current_source text;
  v_next_version integer;
begin
  if p_company_id is null or p_rule_engine_run_id is null
     or p_employee_id is null or p_work_date is null
     or p_attendance_status_id is null or p_source_hash is null
     or p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Comando de código diario inválido.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if not exists (
    select 1 from public.rule_engine_runs r
    where r.id = p_rule_engine_run_id
      and r.company_id = p_company_id
      and r.work_date = p_work_date
      and r.status = 'RUNNING'
  ) then
    raise exception 'La corrida del motor ya no posee el lease de este dia.' using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_company_id::text || '|' || p_employee_id::text || '|' || p_work_date::text,
      3
    )
  );

  if not exists (
    select 1
    from public.employees e
    where e.id = p_employee_id
      and e.company_id = p_company_id
  ) then
    raise exception 'El trabajador no pertenece a la empresa indicada.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.attendance_statuses ats
    where ats.id = p_attendance_status_id
      and ats.code in ('P', '?')
  ) then
    raise exception 'El motor solo puede publicar los códigos P o ?.'
      using errcode = '22023';
  end if;

  select asr.id, asr.attendance_status_id, asr.source
    into v_current_id, v_current_status_id, v_current_source
  from public.attendance_status_records asr
  where asr.employee_id = p_employee_id
    and asr.work_date = p_work_date
    and asr.is_current
  for update;

  if v_current_id is not null and v_current_source <> 'system' then
    return false;
  end if;
  if v_current_id is not null and v_current_status_id = p_attendance_status_id then
    return false;
  end if;

  select coalesce(pg_catalog.max(asr.source_version), 0) + 1
    into v_next_version
  from public.attendance_status_records asr
  where asr.employee_id = p_employee_id
    and asr.work_date = p_work_date;

  if v_current_id is not null then
    update public.attendance_status_records
    set is_current = false
    where id = v_current_id;
  end if;

  insert into public.attendance_status_records (
    employee_id,
    work_date,
    attendance_status_id,
    source,
    source_hash,
    source_version
  ) values (
    p_employee_id,
    p_work_date,
    p_attendance_status_id,
    'system',
    p_source_hash,
    v_next_version
  );

  return true;
end;
$$;

revoke all on function public.replace_system_attendance_status(
  uuid, uuid, uuid, date, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.replace_system_attendance_status(
  uuid, uuid, uuid, date, uuid, text
) to service_role;
revoke insert, update, delete on public.attendance_status_records
  from service_role;

-- Cuando una jornada deja de corresponder (exención, descanso, feriado sin
-- marcas o ausencia de horario), el motor debe retirar su P/? sin recuperar
-- el UPDATE directo que se revocó arriba. El tenant explícito del orquestador
-- se contrasta con el trabajador y la operación comparte el mismo orden de
-- locks que el reemplazo para no competir con cierre/aceptación.
create or replace function public.retire_system_attendance_status(
  p_company_id uuid,
  p_employee_id uuid,
  p_work_date date
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_company_id uuid;
  v_current_id uuid;
begin
  if p_company_id is null or p_employee_id is null or p_work_date is null then
    raise exception 'Comando de retiro de código diario inválido.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  select e.company_id
    into v_employee_company_id
  from public.employees e
  where e.id = p_employee_id;

  if v_employee_company_id is null or v_employee_company_id <> p_company_id then
    raise exception 'El trabajador no pertenece a la empresa indicada.'
      using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_company_id::text || '|' || p_employee_id::text || '|' || p_work_date::text,
      3
    )
  );

  select asr.id
    into v_current_id
  from public.attendance_status_records asr
  where asr.employee_id = p_employee_id
    and asr.work_date = p_work_date
    and asr.source = 'system'
    and asr.is_current
  for update;

  if v_current_id is null then
    return false;
  end if;

  update public.attendance_status_records
  set is_current = false
  where id = v_current_id;

  return true;
end;
$$;

revoke all on function public.retire_system_attendance_status(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.retire_system_attendance_status(uuid, uuid, date)
  to service_role;

-- La raíz diaria de Workera también se versiona en un único commit. Un hash
-- NULL significa retirar únicamente la versión Workera vigente; un hash
-- SHA-256 reemplaza (o recupera idempotentemente) la raíz sin dejar una
-- ventana sin fila current si la inserción o la respuesta HTTP falla.
create or replace function public.replace_workera_attendance_record(
  p_company_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_actual_clock_in timestamptz,
  p_actual_clock_out timestamptz,
  p_source_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_id uuid;
  v_current_source text;
  v_current_hash text;
  v_next_version integer;
  v_new_id uuid;
begin
  if p_company_id is null or p_employee_id is null or p_work_date is null then
    raise exception 'Comando de asistencia diaria inválido.'
      using errcode = '22023';
  end if;
  if p_source_hash is not null and p_source_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'La huella de asistencia diaria no es SHA-256.'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_company_id::text || '|' || p_employee_id::text || '|' || p_work_date::text,
      4
    )
  );

  if not exists (
    select 1
    from public.employees e
    where e.id = p_employee_id
      and e.company_id = p_company_id
  ) then
    raise exception 'El trabajador no pertenece a la empresa indicada.'
      using errcode = '42501';
  end if;

  select ar.id, ar.source, ar.source_hash
    into v_current_id, v_current_source, v_current_hash
  from public.attendance_records ar
  where ar.employee_id = p_employee_id
    and ar.work_date = p_work_date
    and ar.is_current
  for update;

  if p_source_hash is null then
    if v_current_id is not null and v_current_source = 'workera' then
      update public.attendance_records
      set is_current = false
      where id = v_current_id;
    end if;
    return null;
  end if;

  if v_current_id is not null and v_current_source <> 'workera' then
    raise exception 'La asistencia manual vigente no puede ser reemplazada por Workera.'
      using errcode = '42501';
  end if;
  if v_current_id is not null and v_current_hash = p_source_hash then
    return v_current_id;
  end if;

  select coalesce(pg_catalog.max(ar.source_version), 0) + 1
    into v_next_version
  from public.attendance_records ar
  where ar.employee_id = p_employee_id
    and ar.work_date = p_work_date;

  if v_current_id is not null then
    update public.attendance_records
    set is_current = false
    where id = v_current_id;
  end if;

  insert into public.attendance_records (
    employee_id,
    work_date,
    actual_clock_in,
    actual_clock_out,
    source,
    source_hash,
    source_version
  ) values (
    p_employee_id,
    p_work_date,
    p_actual_clock_in,
    p_actual_clock_out,
    'workera',
    p_source_hash,
    v_next_version
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.replace_workera_attendance_record(
  uuid, uuid, date, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.replace_workera_attendance_record(
  uuid, uuid, date, timestamptz, timestamptz, text
) to service_role;
revoke insert, update, delete on public.attendance_records from service_role;

-- Publica o retira el grafo base de un trabajador/día como una sola
-- transacción Postgres. Los helpers anteriores quedan owner-only: ninguna
-- capability puede ejecutar una raíz sin retirar también candidatos y P/?.
create or replace function public.reconcile_workera_attendance_day(
  p_company_id uuid,
  p_rule_engine_run_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_actual_clock_in timestamptz,
  p_actual_clock_out timestamptz,
  p_source_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attendance_record_id uuid;
begin
  if p_company_id is null or p_rule_engine_run_id is null
     or p_employee_id is null or p_work_date is null then
    raise exception 'Comando de reconciliacion diaria invalido.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if not exists (
    select 1 from public.rule_engine_runs r
    where r.id = p_rule_engine_run_id
      and r.company_id = p_company_id
      and r.work_date = p_work_date
      and r.status = 'RUNNING'
  ) then
    raise exception 'La corrida del motor ya no posee el lease de este dia.' using errcode = '55000';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_company_id::text || '|' || p_employee_id::text || '|' || p_work_date::text,
      5
    )
  );

  if not exists (
    select 1
    from public.employees e
    where e.id = p_employee_id
      and e.company_id = p_company_id
  ) then
    raise exception 'El trabajador no pertenece a la empresa indicada.'
      using errcode = '42501';
  end if;

  update public.late_arrival_records
  set is_current = false
  where employee_id = p_employee_id
    and work_date = p_work_date
    and is_current;

  update public.early_departure_records
  set is_current = false
  where employee_id = p_employee_id
    and work_date = p_work_date
    and is_current;

  update public.overtime_records
  set is_current = false
  where employee_id = p_employee_id
    and work_date = p_work_date
    and is_current;

  perform public.retire_system_attendance_status(
    p_company_id,
    p_employee_id,
    p_work_date
  );

  v_attendance_record_id := public.replace_workera_attendance_record(
    p_company_id,
    p_employee_id,
    p_work_date,
    p_actual_clock_in,
    p_actual_clock_out,
    p_source_hash
  );

  return v_attendance_record_id;
end;
$$;

revoke all on function public.reconcile_workera_attendance_day(
  uuid, uuid, uuid, date, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_workera_attendance_day(
  uuid, uuid, uuid, date, timestamptz, timestamptz, text
) to service_role;
revoke execute on function public.retire_system_attendance_status(uuid, uuid, date)
  from service_role;
revoke execute on function public.replace_workera_attendance_record(
  uuid, uuid, date, timestamptz, timestamptz, text
) from service_role;

-- Los tres candidatos calculados tambien son hechos versionados. El patron
-- historico UPDATE(is_current=false) -> INSERT ocurria en dos requests HTTP:
-- una caida entre ambos dejaba el dia sin candidato vigente y un reintento
-- podia reutilizar calculation_version. Cada RPC siguiente serializa por
-- trabajador/dia, revalida todas las FK y hace retiro/reemplazo en un solo
-- commit. `changed` permite que la aplicacion distinga idempotencia real.
create or replace function public.reconcile_late_arrival_candidate(
  p_company_id uuid,
  p_rule_engine_run_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_attendance_record_id uuid,
  p_scheduled_start time,
  p_actual_start timestamptz,
  p_detected_minutes integer,
  p_late_arrival_policy_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_employee_group_id uuid;
  v_current public.late_arrival_records%rowtype;
  v_next_version integer;
  v_new_id uuid;
begin
  if p_company_id is null or p_rule_engine_run_id is null
     or p_employee_id is null or p_work_date is null then
    raise exception 'Comando de atraso invalido.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_employee_id::text || '|' || p_work_date::text, 6)
  );

  if not exists (
    select 1 from public.rule_engine_runs r
    where r.id = p_rule_engine_run_id
      and r.company_id = p_company_id
      and r.work_date = p_work_date
      and r.status = 'RUNNING'
  ) then
    raise exception 'La corrida del motor ya no posee el lease de este dia.' using errcode = '55000';
  end if;

  select e.company_id, ega.employee_group_id
    into v_company_id, v_employee_group_id
  from public.employees e
  left join public.employee_group_assignments ega
    on ega.employee_id = e.id
   and p_work_date between ega.effective_from and coalesce(ega.effective_to, 'infinity'::date)
  left join public.employee_groups eg
    on eg.id = ega.employee_group_id
   and eg.company_id = e.company_id
  where e.id = p_employee_id
    and e.company_id = p_company_id
    and eg.id is not null;
  if v_company_id is null or v_employee_group_id is null then
    raise exception 'Trabajador o grupo historico de atraso inexistente.' using errcode = '22023';
  end if;

  select r.* into v_current
  from public.late_arrival_records r
  where r.employee_id = p_employee_id
    and r.work_date = p_work_date
    and r.is_current
  for update;

  if p_attendance_record_id is null then
    if v_current.id is not null then
      update public.late_arrival_records set is_current = false where id = v_current.id;
    end if;
    return pg_catalog.jsonb_build_object('record_id', null, 'changed', v_current.id is not null);
  end if;

  if p_scheduled_start is null or p_actual_start is null
     or p_detected_minutes is null or p_detected_minutes <= 0
     or p_late_arrival_policy_id is null then
    raise exception 'El candidato de atraso esta incompleto.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
    where ar.id = p_attendance_record_id
      and ar.employee_id = p_employee_id
      and ar.work_date = p_work_date
      and ar.is_current
      and e.company_id = v_company_id
  ) then
    raise exception 'La asistencia base del atraso no esta vigente.' using errcode = '55000';
  end if;
  if not exists (
    select 1
    from public.late_arrival_policies p
    where p.id = p_late_arrival_policy_id
      and p.employee_group_id = v_employee_group_id
      and p.day_of_week = pg_catalog.date_part('dow', p_work_date)::smallint
      and p.effective_from <= p_work_date
      and (p.effective_to is null or p.effective_to >= p_work_date)
  ) then
    raise exception 'La politica de atraso no corresponde al trabajador y fecha.' using errcode = '55000';
  end if;

  if v_current.id is not null
     and v_current.attendance_record_id = p_attendance_record_id
     and v_current.scheduled_start = p_scheduled_start
     and v_current.actual_start = p_actual_start
     and v_current.detected_minutes = p_detected_minutes
     and v_current.late_arrival_policy_id = p_late_arrival_policy_id then
    return pg_catalog.jsonb_build_object('record_id', v_current.id, 'changed', false);
  end if;

  select coalesce(pg_catalog.max(r.calculation_version), 0) + 1
    into v_next_version
  from public.late_arrival_records r
  where r.employee_id = p_employee_id and r.work_date = p_work_date;

  if v_current.id is not null then
    update public.late_arrival_records set is_current = false where id = v_current.id;
  end if;
  insert into public.late_arrival_records (
    employee_id, work_date, attendance_record_id, scheduled_start,
    actual_start, detected_minutes, late_arrival_policy_id, calculation_version
  ) values (
    p_employee_id, p_work_date, p_attendance_record_id, p_scheduled_start,
    p_actual_start, p_detected_minutes, p_late_arrival_policy_id, v_next_version
  ) returning id into v_new_id;

  return pg_catalog.jsonb_build_object('record_id', v_new_id, 'changed', true);
end;
$$;

create or replace function public.reconcile_early_departure_candidate(
  p_company_id uuid,
  p_rule_engine_run_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_attendance_record_id uuid,
  p_scheduled_end time,
  p_actual_end timestamptz,
  p_detected_minutes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_current public.early_departure_records%rowtype;
  v_next_version integer;
  v_new_id uuid;
begin
  if p_company_id is null or p_rule_engine_run_id is null
     or p_employee_id is null or p_work_date is null then
    raise exception 'Comando de salida anticipada invalido.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_employee_id::text || '|' || p_work_date::text, 7)
  );

  if not exists (
    select 1 from public.rule_engine_runs r
    where r.id = p_rule_engine_run_id
      and r.company_id = p_company_id
      and r.work_date = p_work_date
      and r.status = 'RUNNING'
  ) then
    raise exception 'La corrida del motor ya no posee el lease de este dia.' using errcode = '55000';
  end if;

  select e.company_id into v_company_id
  from public.employees e
  where e.id = p_employee_id and e.company_id = p_company_id;
  if v_company_id is null then
    raise exception 'Trabajador de salida anticipada inexistente.' using errcode = '22023';
  end if;
  select r.* into v_current
  from public.early_departure_records r
  where r.employee_id = p_employee_id and r.work_date = p_work_date and r.is_current
  for update;

  if p_attendance_record_id is null then
    if v_current.id is not null then
      update public.early_departure_records set is_current = false where id = v_current.id;
    end if;
    return pg_catalog.jsonb_build_object('record_id', null, 'changed', v_current.id is not null);
  end if;
  if p_scheduled_end is null or p_actual_end is null
     or p_detected_minutes is null or p_detected_minutes <= 0 then
    raise exception 'El candidato de salida anticipada esta incompleto.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
    where ar.id = p_attendance_record_id
      and ar.employee_id = p_employee_id
      and ar.work_date = p_work_date
      and ar.is_current
      and e.company_id = v_company_id
  ) then
    raise exception 'La asistencia base de la salida anticipada no esta vigente.' using errcode = '55000';
  end if;

  if v_current.id is not null
     and v_current.attendance_record_id = p_attendance_record_id
     and v_current.scheduled_end = p_scheduled_end
     and v_current.actual_end = p_actual_end
     and v_current.detected_minutes = p_detected_minutes then
    return pg_catalog.jsonb_build_object('record_id', v_current.id, 'changed', false);
  end if;

  select coalesce(pg_catalog.max(r.calculation_version), 0) + 1
    into v_next_version
  from public.early_departure_records r
  where r.employee_id = p_employee_id and r.work_date = p_work_date;
  if v_current.id is not null then
    update public.early_departure_records set is_current = false where id = v_current.id;
  end if;
  insert into public.early_departure_records (
    employee_id, work_date, attendance_record_id, scheduled_end,
    actual_end, detected_minutes, calculation_version
  ) values (
    p_employee_id, p_work_date, p_attendance_record_id, p_scheduled_end,
    p_actual_end, p_detected_minutes, v_next_version
  ) returning id into v_new_id;

  return pg_catalog.jsonb_build_object('record_id', v_new_id, 'changed', true);
end;
$$;

create or replace function public.reconcile_overtime_candidate(
  p_company_id uuid,
  p_rule_engine_run_id uuid,
  p_employee_id uuid,
  p_work_date date,
  p_attendance_record_id uuid,
  p_candidate_minutes integer,
  p_overtime_policy_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid;
  v_employee_group_id uuid;
  v_overtime_type_id uuid;
  v_current public.overtime_records%rowtype;
  v_next_version integer;
  v_new_id uuid;
begin
  if p_company_id is null or p_rule_engine_run_id is null
     or p_employee_id is null or p_work_date is null then
    raise exception 'Comando de horas extra invalido.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_employee_id::text || '|' || p_work_date::text, 8)
  );

  if not exists (
    select 1 from public.rule_engine_runs r
    where r.id = p_rule_engine_run_id
      and r.company_id = p_company_id
      and r.work_date = p_work_date
      and r.status = 'RUNNING'
  ) then
    raise exception 'La corrida del motor ya no posee el lease de este dia.' using errcode = '55000';
  end if;

  select e.company_id, ega.employee_group_id
    into v_company_id, v_employee_group_id
  from public.employees e
  left join public.employee_group_assignments ega
    on ega.employee_id = e.id
   and p_work_date between ega.effective_from and coalesce(ega.effective_to, 'infinity'::date)
  left join public.employee_groups eg
    on eg.id = ega.employee_group_id
   and eg.company_id = e.company_id
  where e.id = p_employee_id
    and e.company_id = p_company_id
    and eg.id is not null;
  if v_company_id is null or v_employee_group_id is null then
    raise exception 'Trabajador o grupo historico de horas extra inexistente.' using errcode = '22023';
  end if;
  select r.* into v_current
  from public.overtime_records r
  where r.employee_id = p_employee_id and r.work_date = p_work_date and r.is_current
  for update;

  if p_attendance_record_id is null then
    if v_current.id is not null then
      update public.overtime_records set is_current = false where id = v_current.id;
    end if;
    return pg_catalog.jsonb_build_object('record_id', null, 'changed', v_current.id is not null);
  end if;
  if p_candidate_minutes is null or p_candidate_minutes <= 0 or p_overtime_policy_id is null then
    raise exception 'El candidato de horas extra esta incompleto.' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.attendance_records ar
    join public.employees e on e.id = ar.employee_id
    where ar.id = p_attendance_record_id
      and ar.employee_id = p_employee_id
      and ar.work_date = p_work_date
      and ar.is_current
      and e.company_id = v_company_id
  ) then
    raise exception 'La asistencia base de horas extra no esta vigente.' using errcode = '55000';
  end if;
  if not exists (
    select 1
    from public.overtime_policies p
    where p.id = p_overtime_policy_id
      and p.employee_group_id = v_employee_group_id
      and p.overtime_eligible
      and p.day_of_week = pg_catalog.date_part('dow', p_work_date)::smallint
      and p.effective_from <= p_work_date
      and (p.effective_to is null or p.effective_to >= p_work_date)
  ) then
    raise exception 'La politica de horas extra no corresponde al trabajador y fecha.' using errcode = '55000';
  end if;
  v_overtime_type_id := public.classify_overtime_type_id(p_work_date);
  if v_overtime_type_id is null then
    raise exception 'No existe una tasa HH50/HH100 para la fecha.' using errcode = '55000';
  end if;

  if v_current.id is not null
     and v_current.attendance_record_id = p_attendance_record_id
     and v_current.overtime_policy_id = p_overtime_policy_id
     and v_current.overtime_type_id = v_overtime_type_id
     and v_current.candidate_minutes = p_candidate_minutes then
    return pg_catalog.jsonb_build_object('record_id', v_current.id, 'changed', false);
  end if;

  select coalesce(pg_catalog.max(r.calculation_version), 0) + 1
    into v_next_version
  from public.overtime_records r
  where r.employee_id = p_employee_id and r.work_date = p_work_date;
  if v_current.id is not null then
    update public.overtime_records set is_current = false where id = v_current.id;
  end if;
  insert into public.overtime_records (
    employee_id, work_date, attendance_record_id, overtime_type_id,
    candidate_minutes, overtime_policy_id, calculation_version
  ) values (
    p_employee_id, p_work_date, p_attendance_record_id, v_overtime_type_id,
    p_candidate_minutes, p_overtime_policy_id, v_next_version
  ) returning id into v_new_id;

  return pg_catalog.jsonb_build_object('record_id', v_new_id, 'changed', true);
end;
$$;

revoke all on function public.reconcile_late_arrival_candidate(
  uuid, uuid, uuid, date, uuid, time, timestamptz, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_late_arrival_candidate(
  uuid, uuid, uuid, date, uuid, time, timestamptz, integer, uuid
) to service_role;
revoke all on function public.reconcile_early_departure_candidate(
  uuid, uuid, uuid, date, uuid, time, timestamptz, integer
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_early_departure_candidate(
  uuid, uuid, uuid, date, uuid, time, timestamptz, integer
) to service_role;
revoke all on function public.reconcile_overtime_candidate(
  uuid, uuid, uuid, date, uuid, integer, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_overtime_candidate(
  uuid, uuid, uuid, date, uuid, integer, uuid
) to service_role;

revoke insert, update, delete on public.late_arrival_records
  from authenticated, service_role;
revoke insert, update, delete on public.early_departure_records
  from authenticated, service_role;
revoke insert, update, delete on public.overtime_records
  from authenticated, service_role;

-- Los metadatos de una corrida son también una frontera de confianza. El
-- service_role de aplicación puede solicitar transiciones, pero no fabricar
-- ni reescribir directamente una corrida terminal para satisfacer el gate de
-- cierre. Inicio, cierre y recuperación se serializan con el mismo lock de
-- mutaciones que usa el motor.
drop function if exists public.reclaim_stale_workera_sync_runs(integer);

create or replace function public.reclaim_stale_workera_sync_runs(
  p_company_id uuid,
  p_stale_after_seconds integer default 900
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_company_id is null or p_stale_after_seconds < 1 then
    raise exception 'Parametros de recuperacion de sync invalidos.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  update public.sync_runs
  set status = 'FAILED',
      finished_at = pg_catalog.clock_timestamp(),
      error_category = 'CONCURRENCY',
      error_summary = pg_catalog.jsonb_build_object(
        'reason', 'STALE_RUNNING_RECLAIMED',
        'started_at', started_at
      )
  where company_id = p_company_id
    and status = 'RUNNING'
    and started_at < pg_catalog.clock_timestamp()
      - pg_catalog.make_interval(secs => p_stale_after_seconds);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.reclaim_stale_workera_sync_runs(uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.reclaim_stale_workera_sync_runs(uuid, integer)
  to service_role;

create or replace function public.begin_workera_sync_run(
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_triggered_by text,
  p_attempt integer,
  p_retry_of uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
begin
  if p_company_id is null or p_period_start is null or p_period_end is null
     or p_period_start <> p_period_end
     or p_triggered_by not in ('CRON', 'MANUAL')
     or p_attempt < 1 then
    raise exception 'Comando de inicio de sync invalido.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.active) then
    raise exception 'Empresa inexistente o inactiva.' using errcode = '42501';
  end if;
  if p_retry_of is not null and not exists (
    select 1 from public.sync_runs sr
    where sr.id = p_retry_of and sr.company_id = p_company_id
  ) then
    raise exception 'La corrida reintentada no pertenece a la empresa.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  if exists (
    select 1 from public.sync_runs sr
    where sr.company_id = p_company_id
      and sr.status = 'RUNNING'
      and sr.target_period_start = p_period_start
      and sr.target_period_end = p_period_end
  ) or exists (
    select 1 from public.rule_engine_runs rr
    where rr.company_id = p_company_id
      and rr.status = 'RUNNING'
      and rr.work_date between p_period_start and p_period_end
  ) then
    return null;
  end if;

  insert into public.sync_runs (
    company_id, status, target_period_start, target_period_end,
    triggered_by, attempt, retry_of
  ) values (
    p_company_id, 'RUNNING', p_period_start, p_period_end,
    p_triggered_by, p_attempt, p_retry_of
  ) returning id into v_run_id;
  return v_run_id;
end;
$$;

revoke all on function public.begin_workera_sync_run(uuid, date, date, text, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_workera_sync_run(uuid, date, date, text, integer, uuid)
  to service_role;

create or replace function public.finish_workera_sync_run(
  p_company_id uuid,
  p_sync_run_id uuid,
  p_status public.sync_run_status,
  p_records_read integer,
  p_records_created integer,
  p_records_updated integer,
  p_records_unchanged integer,
  p_error_summary jsonb,
  p_error_category text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated_id uuid;
begin
  if p_company_id is null or p_sync_run_id is null
     or p_status not in ('SUCCEEDED', 'FAILED')
     or p_records_read < 0 or p_records_created < 0
     or p_records_updated < 0 or p_records_unchanged < 0 then
    raise exception 'Comando de cierre de sync invalido.' using errcode = '22023';
  end if;
  if p_status = 'SUCCEEDED' and (p_error_summary is not null or p_error_category is not null) then
    raise exception 'Una sync exitosa no puede conservar un error.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  update public.sync_runs
  set status = p_status,
      finished_at = pg_catalog.clock_timestamp(),
      records_read = p_records_read,
      records_created = p_records_created,
      records_updated = p_records_updated,
      records_unchanged = p_records_unchanged,
      error_summary = p_error_summary,
      error_category = p_error_category
  where id = p_sync_run_id
    and company_id = p_company_id
    and status = 'RUNNING'
  returning id into v_updated_id;
  return v_updated_id is not null;
end;
$$;

revoke all on function public.finish_workera_sync_run(
  uuid, uuid, public.sync_run_status, integer, integer, integer, integer, jsonb, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_workera_sync_run(
  uuid, uuid, public.sync_run_status, integer, integer, integer, integer, jsonb, text
) to service_role;
revoke insert, update, delete on public.sync_runs from authenticated, service_role;

-- La ingesta cruda versionaba con UPDATE -> INSERT en requests separados y
-- confiaba en mapas sin tenant. Este comando deriva la huella en Postgres,
-- contrasta empresa/empleado/corrida, verifica que el lease siga RUNNING y
-- publica una sola versión vigente de manera atómica.
create or replace function public.upsert_workera_attendance_event(
  p_company_id uuid,
  p_sync_run_id uuid,
  p_employee_id uuid,
  p_external_employee_code text,
  p_attendance_timestamp_raw text,
  p_attendance_type_code smallint,
  p_attendance_type_label text,
  p_attendance_status text,
  p_external_attendance_status text,
  p_origin text,
  p_origin_code text,
  p_device_name text,
  p_checksum text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_work_date date;
  v_local_timestamp timestamp;
  v_fingerprint text;
  v_current public.workera_attendance_events%rowtype;
  v_next_version integer;
begin
  if p_company_id is null or p_sync_run_id is null or p_employee_id is null
     or nullif(pg_catalog.btrim(p_external_employee_code), '') is null
     or nullif(pg_catalog.btrim(p_attendance_timestamp_raw), '') is null
     or p_attendance_type_code is null
     or nullif(pg_catalog.btrim(p_attendance_type_label), '') is null
     or nullif(pg_catalog.btrim(p_attendance_status), '') is null
     or nullif(pg_catalog.btrim(p_external_attendance_status), '') is null then
    raise exception 'Evento Workera incompleto.' using errcode = '22023';
  end if;

  if p_attendance_timestamp_raw !~
     '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d{1,6})?$' then
    raise exception 'Timestamp crudo Workera invalido o con zona horaria.' using errcode = '22023';
  end if;
  begin
    v_local_timestamp := p_attendance_timestamp_raw::timestamp;
    if pg_catalog.to_char(v_local_timestamp, 'YYYY-MM-DD"T"HH24:MI:SS')
       <> pg_catalog.substring(p_attendance_timestamp_raw, 1, 19) then
      raise exception 'Timestamp crudo Workera imposible.' using errcode = '22023';
    end if;
    v_work_date := v_local_timestamp::date;
  exception when others then
    raise exception 'Timestamp crudo Workera invalido.' using errcode = '22023';
  end;
  v_fingerprint := 'WORKERA|' || p_external_employee_code || '|'
    || p_attendance_timestamp_raw || '|' || p_attendance_type_code::text
    || '|' || coalesce(p_origin_code, '');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company_id::text || '|' || v_fingerprint, 9)
  );

  if not exists (
    select 1
    from public.sync_runs sr
    where sr.id = p_sync_run_id
      and sr.company_id = p_company_id
      and sr.status = 'RUNNING'
      and v_work_date between sr.target_period_start and sr.target_period_end
    for update
  ) then
    raise exception 'La sincronizacion ya no posee el lease para este evento.' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.rule_engine_runs rr
    where rr.company_id = p_company_id
      and rr.work_date = v_work_date
      and rr.status = 'RUNNING'
  ) then
    raise exception 'No se puede cambiar la fuente mientras el motor procesa el dia.' using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.employees e
    where e.id = p_employee_id
      and e.company_id = p_company_id
      and e.external_workera_id = p_external_employee_code
  ) then
    raise exception 'La ficha Workera no corresponde al trabajador y empresa.' using errcode = '42501';
  end if;

  select e.* into v_current
  from public.workera_attendance_events e
  where e.company_id = p_company_id
    and e.external_fingerprint = v_fingerprint
    and e.is_current
  for update;

  if v_current.id is not null
     and v_current.employee_id = p_employee_id
     and v_current.attendance_type_label = p_attendance_type_label
     and v_current.attendance_status = p_attendance_status
     and v_current.external_attendance_status = p_external_attendance_status
     and v_current.origin is not distinct from p_origin
     and v_current.origin_code is not distinct from p_origin_code
     and v_current.device_name is not distinct from p_device_name
     and v_current.checksum is not distinct from p_checksum then
    return 'UNCHANGED';
  end if;

  select coalesce(pg_catalog.max(e.source_version), 0) + 1
    into v_next_version
  from public.workera_attendance_events e
  where e.company_id = p_company_id
    and e.external_fingerprint = v_fingerprint;

  if v_current.id is not null then
    update public.workera_attendance_events set is_current = false where id = v_current.id;
  end if;
  insert into public.workera_attendance_events (
    company_id,
    employee_id,
    external_employee_code,
    work_date,
    attendance_timestamp_raw,
    attendance_type_code,
    attendance_type_label,
    attendance_status,
    external_attendance_status,
    origin,
    origin_code,
    device_name,
    checksum,
    source_version,
    sync_run_id
  ) values (
    p_company_id,
    p_employee_id,
    p_external_employee_code,
    v_work_date,
    p_attendance_timestamp_raw,
    p_attendance_type_code,
    p_attendance_type_label,
    p_attendance_status,
    p_external_attendance_status,
    p_origin,
    p_origin_code,
    p_device_name,
    p_checksum,
    v_next_version,
    p_sync_run_id
  );

  return case when v_next_version = 1 then 'INSERTED' else 'VERSIONED' end;
end;
$$;

revoke all on function public.upsert_workera_attendance_event(
  uuid, uuid, uuid, text, text, smallint, text, text, text, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.upsert_workera_attendance_event(
  uuid, uuid, uuid, text, text, smallint, text, text, text, text, text, text, text
) to service_role;
revoke insert, update, delete on public.workera_attendance_events
  from authenticated, service_role;
-- Cumpleaños es un insumo humano del motor. Los administradores lo editan
-- con su sesión y RLS; service_role solo necesita leerlo al calcular.
revoke insert, update, delete on public.employee_birthdays from service_role;

-- Revisión exclusiva de los INSUMOS del motor. La revisión general de
-- pre-nómina también avanza cuando el propio motor publica sus salidas, por
-- lo que no sirve para demostrar que una corrida se calculó contra la versión
-- vigente de horarios/políticas/marcaciones. Esta revisión separada nunca se
-- incrementa por attendance_records/candidatos/bonos generados.
create table private.attendance_engine_input_revisions (
  company_id uuid primary key references public.companies(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0),
  changed_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table private.attendance_engine_input_revisions enable row level security;
revoke all on table private.attendance_engine_input_revisions
  from public, anon, authenticated, service_role;

create table private.attendance_engine_day_input_revisions (
  company_id uuid not null references public.companies(id) on delete cascade,
  work_date date not null,
  revision bigint not null default 0 check (revision >= 0),
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (company_id, work_date)
);
alter table private.attendance_engine_day_input_revisions enable row level security;
revoke all on table private.attendance_engine_day_input_revisions
  from public, anon, authenticated, service_role;

create table private.workera_sync_requirements (
  company_id uuid primary key references public.companies(id) on delete cascade,
  required_from date not null,
  configured_at timestamptz not null default pg_catalog.clock_timestamp()
);
alter table private.workera_sync_requirements enable row level security;
revoke all on table private.workera_sync_requirements
  from public, anon, authenticated, service_role;
insert into private.workera_sync_requirements (company_id, required_from)
values ('0a4c0000-0000-0000-0000-000000000001'::uuid, date '2026-08-18');

insert into private.attendance_engine_input_revisions (company_id, revision)
select c.id, 1 from public.companies c
on conflict (company_id) do nothing;

alter table public.rule_engine_runs
  add column input_revision bigint not null default 0,
  add column day_input_revision bigint not null default 0;

create or replace function private.advance_attendance_engine_input_revision(
  p_company_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_company_id is null then return; end if;
  insert into private.attendance_engine_input_revisions as r (
    company_id, revision, changed_at
  ) values (
    p_company_id, 1, pg_catalog.clock_timestamp()
  )
  on conflict (company_id) do update
  set revision = r.revision + 1,
      changed_at = excluded.changed_at;
end;
$$;
revoke all on function private.advance_attendance_engine_input_revision(uuid)
  from public, anon, authenticated, service_role;

create or replace function private.advance_attendance_engine_day_input_revision(
  p_company_id uuid,
  p_work_date date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_company_id is null or p_work_date is null then return; end if;
  insert into private.attendance_engine_day_input_revisions as r (
    company_id, work_date, revision, changed_at
  ) values (
    p_company_id, p_work_date, 1, pg_catalog.clock_timestamp()
  )
  on conflict (company_id, work_date) do update
  set revision = r.revision + 1,
      changed_at = excluded.changed_at;
end;
$$;
revoke all on function private.advance_attendance_engine_day_input_revision(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function private.bump_attendance_engine_input_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_rows jsonb[];
  v_company_id uuid;
  v_previous_company_id uuid;
  v_arcotex constant uuid := '0a4c0000-0000-0000-0000-000000000001'::uuid;
begin
  if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then return new; end if;
  if tg_op = 'INSERT' then v_rows := array[to_jsonb(new)];
  elsif tg_op = 'DELETE' then v_rows := array[to_jsonb(old)];
  else v_rows := array[to_jsonb(old), to_jsonb(new)];
  end if;

  foreach v_row in array v_rows loop
    v_company_id := null;
    case
      when tg_table_name in (
        'employee_groups', 'employees',
        'organization_units', 'employee_org_assignments', 'work_schedules',
        'work_schedule_rules', 'schedule_assignments'
      ) then
        v_company_id := nullif(v_row ->> 'company_id', '')::uuid;
      when tg_table_name in (
        'employee_time_control_policies', 'employee_group_assignments',
        'employee_birthdays'
      ) then
        select e.company_id into v_company_id
        from public.employees e
        where e.id = nullif(v_row ->> 'employee_id', '')::uuid;
      when tg_table_name in ('overtime_policies', 'late_arrival_policies', 'bonus_policies') then
        select g.company_id into v_company_id
        from public.employee_groups g
        where g.id = nullif(v_row ->> 'employee_group_id', '')::uuid;
      when tg_table_name in ('holidays', 'attendance_statuses', 'overtime_types') then
        v_company_id := v_arcotex;
      else
        raise exception 'Insumo del motor sin estrategia de tenant: %', tg_table_name
          using errcode = '55000';
    end case;
    if v_company_id is distinct from v_previous_company_id then
      perform private.advance_attendance_engine_input_revision(v_company_id);
    end if;
    v_previous_company_id := v_company_id;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.bump_attendance_engine_input_revision()
  from public, anon, authenticated, service_role;

create or replace function private.bump_attendance_engine_day_input_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_rows jsonb[];
  v_company_id uuid;
  v_work_date date;
  v_previous_key text;
begin
  if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then return new; end if;
  if tg_op = 'INSERT' then v_rows := array[to_jsonb(new)];
  elsif tg_op = 'DELETE' then v_rows := array[to_jsonb(old)];
  else v_rows := array[to_jsonb(old), to_jsonb(new)];
  end if;

  foreach v_row in array v_rows loop
    v_company_id := null;
    v_work_date := null;
    if tg_table_name = 'workera_attendance_events' then
      v_company_id := nullif(v_row ->> 'company_id', '')::uuid;
      v_work_date := nullif(v_row ->> 'work_date', '')::date;
    elsif tg_table_name = 'attendance_corrections' then
      select e.company_id, ar.work_date into v_company_id, v_work_date
      from public.attendance_records ar
      join public.employees e on e.id = ar.employee_id
      where ar.id = nullif(v_row ->> 'attendance_record_id', '')::uuid;
    else
      raise exception 'Insumo diario del motor sin estrategia: %', tg_table_name
        using errcode = '55000';
    end if;
    if concat_ws('|', v_company_id::text, v_work_date::text)
       is distinct from v_previous_key then
      perform private.advance_attendance_engine_day_input_revision(v_company_id, v_work_date);
    end if;
    v_previous_key := concat_ws('|', v_company_id::text, v_work_date::text);
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.bump_attendance_engine_day_input_revision()
  from public, anon, authenticated, service_role;

do $create_engine_input_revision_triggers$
declare
  v_table text;
begin
  foreach v_table in array array[
    'employee_groups', 'employees',
    'organization_units', 'employee_org_assignments', 'work_schedules',
    'work_schedule_rules', 'schedule_assignments',
    'employee_time_control_policies', 'employee_group_assignments',
    'employee_birthdays',
    'overtime_policies', 'late_arrival_policies', 'bonus_policies',
    'holidays', 'attendance_statuses', 'overtime_types'
  ] loop
    execute pg_catalog.format(
      'drop trigger if exists attendance_engine_input_revision_fence on public.%I',
      v_table
    );
    execute pg_catalog.format(
      'create trigger attendance_engine_input_revision_fence '
      || 'before insert or update or delete on public.%I '
      || 'for each row execute function private.bump_attendance_engine_input_revision()',
      v_table
    );
  end loop;
end;
$create_engine_input_revision_triggers$;

drop trigger if exists attendance_engine_day_input_revision_fence
  on public.workera_attendance_events;
create trigger attendance_engine_day_input_revision_fence
  before insert or update or delete on public.workera_attendance_events
  for each row execute function private.bump_attendance_engine_day_input_revision();

drop trigger if exists attendance_engine_day_input_revision_fence
  on public.attendance_corrections;
create trigger attendance_engine_day_input_revision_fence
  before insert or update or delete on public.attendance_corrections
  for each row execute function private.bump_attendance_engine_day_input_revision();

-- Apertura atómica del lease del motor. Un sync del mismo día y una
-- derivación nunca quedan RUNNING simultáneamente; el mismo lock global que
-- usa la ingesta elimina la ventana SELECT -> INSERT entre requests.
create or replace function public.begin_attendance_rule_engine_run(
  p_company_id uuid,
  p_work_date date,
  p_triggered_by text,
  p_triggered_by_profile uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run_id uuid;
  v_input_revision bigint;
  v_day_input_revision bigint;
begin
  if p_company_id is null or p_work_date is null
     or p_triggered_by not in ('CRON', 'MANUAL') then
    raise exception 'Comando de inicio del motor invalido.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies c where c.id = p_company_id and c.active) then
    raise exception 'Empresa inexistente o inactiva.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  if exists (
    select 1 from public.sync_runs sr
    where sr.company_id = p_company_id
      and sr.status = 'RUNNING'
      and p_work_date between sr.target_period_start and sr.target_period_end
  ) or exists (
    select 1 from public.rule_engine_runs rr
    where rr.company_id = p_company_id
      and rr.work_date = p_work_date
      and rr.status = 'RUNNING'
  ) then
    return null;
  end if;

  insert into private.attendance_engine_input_revisions as r (
    company_id, revision, changed_at
  ) values (
    p_company_id, 1, pg_catalog.clock_timestamp()
  ) on conflict (company_id) do update
    set revision = r.revision
  returning revision into v_input_revision;
  insert into private.attendance_engine_day_input_revisions as r (
    company_id, work_date, revision, changed_at
  ) values (
    p_company_id, p_work_date, 0, pg_catalog.clock_timestamp()
  ) on conflict (company_id, work_date) do update
    set revision = r.revision
  returning revision into v_day_input_revision;

  insert into public.rule_engine_runs (
    company_id, work_date, status, triggered_by, triggered_by_profile,
    input_revision, day_input_revision
  ) values (
    p_company_id, p_work_date, 'RUNNING', p_triggered_by,
    p_triggered_by_profile, v_input_revision, v_day_input_revision
  ) returning id into v_run_id;
  return v_run_id;
end;
$$;

revoke all on function public.begin_attendance_rule_engine_run(uuid, date, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_attendance_rule_engine_run(uuid, date, text, uuid)
  to service_role;

create or replace function public.finish_attendance_rule_engine_run(
  p_company_id uuid,
  p_rule_engine_run_id uuid,
  p_status text,
  p_employees_processed integer,
  p_attendance_derived integer,
  p_late_candidates integer,
  p_early_departure_candidates integer,
  p_overtime_candidates integer,
  p_without_schedule integer,
  p_failure_count integer,
  p_error_summary text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.rule_engine_runs%rowtype;
  v_current_revision bigint;
  v_current_day_revision bigint;
begin
  if p_company_id is null or p_rule_engine_run_id is null
     or p_status not in ('SUCCEEDED', 'PARTIAL', 'FAILED')
     or p_employees_processed < 0 or p_attendance_derived < 0
     or p_late_candidates < 0 or p_early_departure_candidates < 0
     or p_overtime_candidates < 0 or p_without_schedule < 0
     or p_failure_count < 0 or pg_catalog.char_length(coalesce(p_error_summary, '')) > 500 then
    raise exception 'Comando de cierre del motor invalido.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  select rr.* into v_run
  from public.rule_engine_runs rr
  where rr.id = p_rule_engine_run_id
    and rr.company_id = p_company_id
    and rr.status = 'RUNNING'
  for update;
  if v_run.id is null then return 'LEASE_LOST'; end if;

  select r.revision into v_current_revision
  from private.attendance_engine_input_revisions r
  where r.company_id = p_company_id;
  select r.revision into v_current_day_revision
  from private.attendance_engine_day_input_revisions r
  where r.company_id = p_company_id and r.work_date = v_run.work_date;

  if p_status <> 'FAILED'
     and (
       v_run.input_revision is distinct from v_current_revision
       or v_run.day_input_revision is distinct from v_current_day_revision
     ) then
    update public.rule_engine_runs
    set status = 'FAILED',
        finished_at = pg_catalog.clock_timestamp(),
        failure_count = greatest(p_failure_count, 1),
        error_summary = 'Los insumos cambiaron durante la corrida; es obligatorio recalcular.'
    where id = v_run.id;
    return 'STALE_INPUTS';
  end if;

  update public.rule_engine_runs
  set status = p_status,
      finished_at = pg_catalog.clock_timestamp(),
      employees_processed = p_employees_processed,
      attendance_derived = p_attendance_derived,
      late_candidates = p_late_candidates,
      early_departure_candidates = p_early_departure_candidates,
      overtime_candidates = p_overtime_candidates,
      without_schedule = p_without_schedule,
      failure_count = p_failure_count,
      error_summary = p_error_summary
  where id = v_run.id;
  return 'FINISHED';
end;
$$;

revoke all on function public.finish_attendance_rule_engine_run(
  uuid, uuid, text, integer, integer, integer, integer, integer, integer, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.finish_attendance_rule_engine_run(
  uuid, uuid, text, integer, integer, integer, integer, integer, integer, integer, text
) to service_role;
revoke insert, update, delete on public.rule_engine_runs from authenticated, service_role;

-- El guard heredado cubria solo INSERT. Una escritura del owner de la base o
-- una capability futura no debe poder editar/borrar historia dentro de CLOSED.
-- Se revisan OLD y NEW para que tampoco un cambio de FK saque el hecho del
-- rango cerrado antes de validar la procedencia.
create or replace function public.prevent_labor_decision_on_closed_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_rows jsonb[];
  v_company_id uuid;
  v_start_date date;
  v_end_date date;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if tg_op = 'INSERT' then
    v_rows := array[to_jsonb(new)];
  elsif tg_op = 'DELETE' then
    v_rows := array[to_jsonb(old)];
  else
    v_rows := array[to_jsonb(old), to_jsonb(new)];
  end if;

  foreach v_row in array v_rows
  loop
    v_company_id := null;
    v_start_date := null;
    v_end_date := null;

    if tg_table_name = 'overtime_decisions' then
      select e.company_id, r.work_date, r.work_date
        into v_company_id, v_start_date, v_end_date
      from public.overtime_records r
      join public.employees e on e.id = r.employee_id
      where r.id = nullif(v_row ->> 'overtime_record_id', '')::uuid;
    elsif tg_table_name = 'late_arrival_decisions' then
      select e.company_id, r.work_date, r.work_date
        into v_company_id, v_start_date, v_end_date
      from public.late_arrival_records r
      join public.employees e on e.id = r.employee_id
      where r.id = nullif(v_row ->> 'late_arrival_record_id', '')::uuid;
    elsif tg_table_name = 'early_departure_decisions' then
      select e.company_id, r.work_date, r.work_date
        into v_company_id, v_start_date, v_end_date
      from public.early_departure_records r
      join public.employees e on e.id = r.employee_id
      where r.id = nullif(v_row ->> 'early_departure_record_id', '')::uuid;
    elsif tg_table_name = 'absence_decisions' then
      select e.company_id, r.start_date, r.end_date
        into v_company_id, v_start_date, v_end_date
      from public.absence_records r
      join public.employees e on e.id = r.employee_id
      where r.id = nullif(v_row ->> 'absence_record_id', '')::uuid;
    else
      raise exception 'Tabla de decision laboral no soportada.' using errcode = '22023';
    end if;

    if v_company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
       and exists (
         select 1
         from public.reporting_periods rp
         where rp.status = 'CLOSED'
           and pg_catalog.daterange(rp.period_start, rp.period_end, '[]')
             && pg_catalog.daterange(v_start_date, v_end_date, '[]')
       ) then
      raise exception 'No se puede modificar una decision de asistencia dentro de un periodo cerrado.'
        using errcode = '55000';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.prevent_labor_decision_on_closed_period()
  from public, anon, authenticated, service_role;

drop trigger if exists overtime_decisions_prevent_closed_period on public.overtime_decisions;
create trigger overtime_decisions_prevent_closed_period
  before insert or update or delete on public.overtime_decisions
  for each row execute function public.prevent_labor_decision_on_closed_period();

drop trigger if exists late_arrival_decisions_prevent_closed_period on public.late_arrival_decisions;
create trigger late_arrival_decisions_prevent_closed_period
  before insert or update or delete on public.late_arrival_decisions
  for each row execute function public.prevent_labor_decision_on_closed_period();

drop trigger if exists early_departure_decisions_prevent_closed_period on public.early_departure_decisions;
create trigger early_departure_decisions_prevent_closed_period
  before insert or update or delete on public.early_departure_decisions
  for each row execute function public.prevent_labor_decision_on_closed_period();

drop trigger if exists absence_decisions_prevent_closed_period on public.absence_decisions;
create trigger absence_decisions_prevent_closed_period
  before insert or update or delete on public.absence_decisions
  for each row execute function public.prevent_labor_decision_on_closed_period();

-- employee_group_assignments es la fuente histórica usada para autorizar a
-- supervisores, pero el roster legacy solo mantenía el caché en employees.
-- Primero se reconcilia el estado existente sin inventar cambios pasados:
-- una clasificación distinta empieza hoy y la cobertura previa se conserva.
do $assert_group_assignment_tenants$
begin
  if exists (
    select 1
    from public.employee_group_assignments ega
    join public.employees e on e.id = ega.employee_id
    join public.employee_groups eg on eg.id = ega.employee_group_id
    where eg.company_id is distinct from e.company_id
  ) then
    raise exception 'Existen asignaciones históricas de grupo entre tenants; deben corregirse antes de migrar.'
      using errcode = '23514';
  end if;
end;
$assert_group_assignment_tenants$;

create or replace function private.assert_employee_group_assignment_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.employees e
    join public.employee_groups eg on eg.id = new.employee_group_id
    where e.id = new.employee_id
      and eg.company_id = e.company_id
  ) then
    raise exception 'El grupo histórico y el trabajador deben pertenecer al mismo tenant.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.assert_employee_group_assignment_tenant()
  from public, anon, authenticated, service_role;

drop trigger if exists employee_group_assignments_tenant_guard
  on public.employee_group_assignments;
create trigger employee_group_assignments_tenant_guard
  before insert or update of employee_id, employee_group_id
  on public.employee_group_assignments
  for each row execute function private.assert_employee_group_assignment_tenant();

update public.employee_group_assignments ega
set effective_to = current_date - 1
from public.employees e
where e.id = ega.employee_id
  and ega.effective_from < current_date
  and current_date between ega.effective_from and coalesce(ega.effective_to, 'infinity'::date)
  and e.employee_group_id is distinct from ega.employee_group_id;

delete from public.employee_group_assignments ega
using public.employees e
where e.id = ega.employee_id
  and ega.effective_from = current_date
  and current_date between ega.effective_from and coalesce(ega.effective_to, 'infinity'::date)
  and e.employee_group_id is null;

update public.employee_group_assignments ega
set employee_group_id = e.employee_group_id
from public.employees e
where e.id = ega.employee_id
  and ega.effective_from = current_date
  and current_date between ega.effective_from and coalesce(ega.effective_to, 'infinity'::date)
  and e.employee_group_id is not null
  and e.employee_group_id is distinct from ega.employee_group_id;

insert into public.employee_group_assignments (
  employee_id,
  employee_group_id,
  effective_from,
  effective_to,
  source
)
select
  e.id,
  e.employee_group_id,
  case
    when not exists (
      select 1 from public.employee_group_assignments any_ega
      where any_ega.employee_id = e.id
    ) then least(
      current_date,
      e.created_at::date,
      coalesce(e.hire_date, current_date),
      coalesce(facts.first_date, current_date)
    )
    else current_date
  end,
  (
    select min(future_ega.effective_from) - 1
    from public.employee_group_assignments future_ega
    where future_ega.employee_id = e.id
      and future_ega.effective_from > current_date
  ),
  'internal'
from public.employees e
left join lateral (
  select min(event_date) as first_date
  from (
    select ar.work_date as event_date
    from public.attendance_records ar
    where ar.employee_id = e.id
    union all
    select lar.work_date from public.late_arrival_records lar where lar.employee_id = e.id
    union all
    select edr.work_date from public.early_departure_records edr where edr.employee_id = e.id
    union all
    select otr.work_date from public.overtime_records otr where otr.employee_id = e.id
    union all
    select abr.start_date from public.absence_records abr where abr.employee_id = e.id
  ) evidence
) facts on true
where e.employee_group_id is not null
  and not exists (
    select 1
    from public.employee_group_assignments current_ega
    where current_ega.employee_id = e.id
      and current_date between current_ega.effective_from
        and coalesce(current_ega.effective_to, 'infinity'::date)
  );

create or replace function private.sync_employee_group_history_from_cache()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current_id uuid;
  v_current_group_id uuid;
  v_current_from date;
  v_next_from date;
  v_has_history boolean;
  v_initial_from date;
begin
  if tg_op = 'UPDATE' and new.employee_group_id is not distinct from old.employee_group_id then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if new.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
     and exists (
       select 1
       from public.reporting_periods rp
       where rp.status = 'CLOSED'
         and current_date between rp.period_start and rp.period_end
     ) then
    raise exception 'Reabre el periodo antes de cambiar el grupo vigente del trabajador.'
      using errcode = '55000';
  end if;

  select ega.id, ega.employee_group_id, ega.effective_from
    into v_current_id, v_current_group_id, v_current_from
  from public.employee_group_assignments ega
  where ega.employee_id = new.id
    and current_date between ega.effective_from and coalesce(ega.effective_to, 'infinity'::date)
  for update;

  if v_current_id is not null and v_current_group_id is not distinct from new.employee_group_id then
    return new;
  end if;

  if v_current_id is not null then
    if v_current_from = current_date then
      if new.employee_group_id is null then
        delete from public.employee_group_assignments where id = v_current_id;
      else
        update public.employee_group_assignments
        set employee_group_id = new.employee_group_id
        where id = v_current_id;
      end if;
    else
      update public.employee_group_assignments
      set effective_to = current_date - 1
      where id = v_current_id;
    end if;
  end if;

  if new.employee_group_id is not null
     and not (v_current_id is not null and v_current_from = current_date) then
    select exists (
      select 1
      from public.employee_group_assignments ega
      where ega.employee_id = new.id
    ) into v_has_history;

    if not v_has_history then
      select least(
        current_date,
        new.created_at::date,
        coalesce(new.hire_date, current_date),
        coalesce(min(evidence.event_date), current_date)
      )
        into v_initial_from
      from (
        select ar.work_date as event_date
        from public.attendance_records ar
        where ar.employee_id = new.id
        union all
        select lar.work_date from public.late_arrival_records lar where lar.employee_id = new.id
        union all
        select edr.work_date from public.early_departure_records edr where edr.employee_id = new.id
        union all
        select otr.work_date from public.overtime_records otr where otr.employee_id = new.id
        union all
        select abr.start_date from public.absence_records abr where abr.employee_id = new.id
      ) evidence;
    else
      v_initial_from := current_date;
    end if;

    select min(ega.effective_from) into v_next_from
    from public.employee_group_assignments ega
    where ega.employee_id = new.id
      and ega.effective_from > v_initial_from;

    insert into public.employee_group_assignments (
      employee_id, employee_group_id, effective_from, effective_to, source
    ) values (
      new.id,
      new.employee_group_id,
      v_initial_from,
      case when v_next_from is null then null else v_next_from - 1 end,
      'internal'
    );
  end if;

  return new;
end;
$$;

revoke all on function private.sync_employee_group_history_from_cache()
  from public, anon, authenticated, service_role;

drop trigger if exists employees_sync_group_history_after_insert on public.employees;
create trigger employees_sync_group_history_after_insert
  after insert on public.employees
  for each row execute function private.sync_employee_group_history_from_cache();

drop trigger if exists employees_sync_group_history_after_update on public.employees;
create trigger employees_sync_group_history_after_update
  after update of employee_group_id on public.employees
  for each row execute function private.sync_employee_group_history_from_cache();

-- La única vía de escritura queda ligada al caché de employees. Las sesiones
-- y capabilities pueden leer el historial, pero no desalinearlo por REST.
revoke insert, update, delete on public.employee_group_assignments
  from authenticated, service_role;

create or replace function private.prevent_employee_company_reassignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'La empresa de un trabajador es inmutable; crea una nueva alta sin reatribuir su historia.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_employee_company_reassignment()
  from public, anon, authenticated, service_role;

drop trigger if exists employees_company_is_immutable on public.employees;
create trigger employees_company_is_immutable
  before update of company_id on public.employees
  for each row execute function private.prevent_employee_company_reassignment();

-- Toda autoridad operacional usa el grupo efectivo en la fecha del hecho.
-- El caché actual de employees nunca autoriza una corrección histórica.
drop policy if exists attendance_corrections_insert on public.attendance_corrections;
create policy attendance_corrections_insert on public.attendance_corrections
  for insert to authenticated
  with check (
    corrected_by = auth.uid()
    and public.can_manage_employee_on_date(employee_id, work_date)
  );

drop policy if exists attendance_corrections_update_admin on public.attendance_corrections;
create policy attendance_corrections_update_admin on public.attendance_corrections
  for update to authenticated
  using (exists (
    select 1 from public.employees e
    where e.id = employee_id
      and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
  ))
  with check (exists (
    select 1 from public.employees e
    where e.id = employee_id
      and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
  ));

drop policy if exists attendance_status_records_insert on public.attendance_status_records;
create policy attendance_status_records_insert on public.attendance_status_records
  for insert to authenticated
  with check (
    case
      when source = 'manual' then
        created_by = auth.uid()
        and public.can_manage_employee_on_date(employee_id, work_date)
      else exists (
        select 1 from public.employees e
        where e.id = employee_id
          and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
      )
    end
  );

drop policy if exists attendance_status_records_update_admin on public.attendance_status_records;
create policy attendance_status_records_update_admin on public.attendance_status_records
  for update to authenticated
  using (exists (
    select 1 from public.employees e
    where e.id = employee_id
      and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
  ))
  with check (exists (
    select 1 from public.employees e
    where e.id = employee_id
      and public.has_company_app_role(e.company_id, 'ADMIN_RRHH')
  ));

drop policy if exists attendance_missing_punch_flags_update
  on public.attendance_missing_punch_flags;
create policy attendance_missing_punch_flags_update
  on public.attendance_missing_punch_flags
  for update to authenticated
  using (public.can_manage_employee_on_date(employee_id, work_date))
  with check (public.can_manage_employee_on_date(employee_id, work_date));

-- El workflow puede avanzar estado/notas y completar su atribución, pero la
-- alerta nunca cambia de hecho, trabajador, fecha ni tipo después de creada.
drop trigger if exists attendance_missing_punch_flags_identity_immutable
  on public.attendance_missing_punch_flags;
create trigger attendance_missing_punch_flags_identity_immutable
  before update on public.attendance_missing_punch_flags
  for each row execute function public.enforce_immutable_columns(
    'status',
    'contacted_by',
    'contacted_at',
    'resolved_by',
    'resolved_at',
    'notes',
    'updated_at'
  );

-- Las capas derivadas o humanas que alimentan el Excel se congelan por fecha
-- al cerrar. El hecho crudo de Workera (attendance_records) queda fuera: puede
-- seguir ingresando como evidencia, pero no cambia códigos, candidatos,
-- correcciones, ausencias ni bonos oficiales sin una reapertura.
create or replace function private.prevent_payroll_layer_mutation_on_closed_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_rows jsonb[];
  v_company_id uuid;
  v_start_date date;
  v_end_date date;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if tg_op = 'INSERT' then
    v_rows := array[to_jsonb(new)];
  elsif tg_op = 'DELETE' then
    v_rows := array[to_jsonb(old)];
  else
    v_rows := array[to_jsonb(old), to_jsonb(new)];
  end if;

  foreach v_row in array v_rows
  loop
    v_company_id := null;
    v_start_date := null;
    v_end_date := null;

    if tg_table_name = 'employee_birthdays' then
      select e.company_id into v_company_id
      from public.employees e
      where e.id = nullif(v_row ->> 'employee_id', '')::uuid;

      -- El cumpleaños determina si una salida anterior a las 12:00 genera
      -- candidato. OLD y NEW se revisan por separado para que cambiar tanto
      -- la fecha como el trabajador quede bloqueado si altera cualquier día
      -- ya cerrado. generate_series evita errores con 29 de febrero.
      if v_company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
         and exists (
           select 1
           from public.reporting_periods rp
           cross join lateral pg_catalog.generate_series(
             rp.period_start,
             rp.period_end,
             interval '1 day'
           ) as closed_day
           where rp.status = 'CLOSED'
             and pg_catalog.date_part('month', closed_day)::integer =
               nullif(v_row ->> 'birth_month', '')::integer
             and pg_catalog.date_part('day', closed_day)::integer =
               nullif(v_row ->> 'birth_day', '')::integer
         ) then
        raise exception 'Reabre el periodo antes de cambiar un cumpleaños que afecta asistencia.'
          using errcode = '55000';
      end if;
    elsif tg_table_name = 'absence_records' then
      select e.company_id into v_company_id
      from public.employees e
      where e.id = nullif(v_row ->> 'employee_id', '')::uuid;
      v_start_date := nullif(v_row ->> 'start_date', '')::date;
      v_end_date := nullif(v_row ->> 'end_date', '')::date;
    elsif tg_table_name = 'medical_license_approvals' then
      select e.company_id, ar.start_date, ar.end_date
        into v_company_id, v_start_date, v_end_date
      from public.absence_records ar
      join public.employees e on e.id = ar.employee_id
      where ar.id = nullif(v_row ->> 'absence_record_id', '')::uuid;
    elsif tg_table_name = 'supporting_documents' then
      if nullif(v_row ->> 'absence_record_id', '') is not null then
        select e.company_id, ar.start_date, ar.end_date
          into v_company_id, v_start_date, v_end_date
        from public.absence_records ar
        join public.employees e on e.id = ar.employee_id
        where ar.id = nullif(v_row ->> 'absence_record_id', '')::uuid;
      elsif nullif(v_row ->> 'late_arrival_decision_id', '') is not null then
        select e.company_id, lar.work_date, lar.work_date
          into v_company_id, v_start_date, v_end_date
        from public.late_arrival_decisions lad
        join public.late_arrival_records lar on lar.id = lad.late_arrival_record_id
        join public.employees e on e.id = lar.employee_id
        where lad.id = nullif(v_row ->> 'late_arrival_decision_id', '')::uuid;
      elsif nullif(v_row ->> 'attendance_status_record_id', '') is not null then
        select e.company_id, asr.work_date, asr.work_date
          into v_company_id, v_start_date, v_end_date
        from public.attendance_status_records asr
        join public.employees e on e.id = asr.employee_id
        where asr.id = nullif(v_row ->> 'attendance_status_record_id', '')::uuid;
      elsif nullif(v_row ->> 'early_departure_record_id', '') is not null then
        select e.company_id, edr.work_date, edr.work_date
          into v_company_id, v_start_date, v_end_date
        from public.early_departure_records edr
        join public.employees e on e.id = edr.employee_id
        where edr.id = nullif(v_row ->> 'early_departure_record_id', '')::uuid;
      else
        -- Un documento general del trabajador no posee fecha de pre-nomina.
        -- Conserva inmutabilidad/ACL, pero no se le atribuye un periodo ficticio.
        select e.company_id into v_company_id
        from public.employees e
        where e.id = nullif(v_row ->> 'employee_id', '')::uuid;
      end if;
    elsif tg_table_name in (
      'attendance_corrections',
      'attendance_status_records',
      'attendance_missing_punch_flags',
      'late_arrival_records',
      'early_departure_records',
      'overtime_records',
      'employee_daily_bonuses'
    ) then
      select e.company_id into v_company_id
      from public.employees e
      where e.id = nullif(v_row ->> 'employee_id', '')::uuid;
      v_start_date := nullif(v_row ->> 'work_date', '')::date;
      v_end_date := v_start_date;
    else
      raise exception 'Capa temporal de pre-nomina no soportada: %', tg_table_name
        using errcode = '22023';
    end if;

    if v_company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
       and v_start_date is not null
       and exists (
         select 1
         from public.reporting_periods rp
         where rp.status = 'CLOSED'
           and pg_catalog.daterange(rp.period_start, rp.period_end, '[]')
             && pg_catalog.daterange(v_start_date, v_end_date, '[]')
       ) then
      raise exception 'Reabre el periodo antes de modificar esta capa de asistencia.'
        using errcode = '55000';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.prevent_payroll_layer_mutation_on_closed_period()
  from public, anon, authenticated, service_role;

do $create_closed_layer_guards$
declare
  v_table text;
begin
  foreach v_table in array array[
    'employee_birthdays',
    'absence_records',
    'medical_license_approvals',
    'supporting_documents',
    'attendance_corrections',
    'attendance_status_records',
    'late_arrival_records',
    'early_departure_records',
    'overtime_records',
    'employee_daily_bonuses'
  ]
  loop
    execute pg_catalog.format(
      'drop trigger if exists payroll_closed_temporal_guard on public.%I',
      v_table
    );
    execute pg_catalog.format(
      'create trigger payroll_closed_temporal_guard '
      || 'before insert or update or delete on public.%I '
      || 'for each row execute function private.prevent_payroll_layer_mutation_on_closed_period()',
      v_table
    );
  end loop;
end;
$create_closed_layer_guards$;

drop trigger if exists payroll_closed_temporal_guard
  on public.attendance_missing_punch_flags;
create trigger payroll_closed_temporal_guard
  before update or delete on public.attendance_missing_punch_flags
  for each row execute function private.prevent_payroll_layer_mutation_on_closed_period();

-- Clasificaciones y centros de costo con vigencia se pueden acortar hacia el
-- futuro, pero nunca cambiar qué valor cubría una fecha ya cerrada.
create or replace function private.prevent_assignment_history_change_on_closed_period()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_row jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  v_new_row jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old_company_id uuid;
  v_new_company_id uuid;
  v_old_range daterange := 'empty'::daterange;
  v_new_range daterange := 'empty'::daterange;
  v_identity_changed boolean := false;
  v_period_range daterange;
  v_old_intersection daterange;
  v_new_intersection daterange;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if v_old_row is not null then
    if tg_table_name = 'employee_group_assignments' then
      select e.company_id into v_old_company_id
      from public.employees e
      where e.id = nullif(v_old_row ->> 'employee_id', '')::uuid;
    else
      v_old_company_id := nullif(v_old_row ->> 'company_id', '')::uuid;
    end if;
    v_old_range := pg_catalog.daterange(
      nullif(v_old_row ->> 'effective_from', '')::date,
      nullif(v_old_row ->> 'effective_to', '')::date,
      '[]'
    );
  end if;

  if v_new_row is not null then
    if tg_table_name = 'employee_group_assignments' then
      select e.company_id into v_new_company_id
      from public.employees e
      where e.id = nullif(v_new_row ->> 'employee_id', '')::uuid;
    else
      v_new_company_id := nullif(v_new_row ->> 'company_id', '')::uuid;
    end if;
    v_new_range := pg_catalog.daterange(
      nullif(v_new_row ->> 'effective_from', '')::date,
      nullif(v_new_row ->> 'effective_to', '')::date,
      '[]'
    );
  end if;

  if tg_op = 'UPDATE' then
    if tg_table_name = 'employee_group_assignments' then
      v_identity_changed := (v_old_row ->> 'employee_id') is distinct from (v_new_row ->> 'employee_id')
        or (v_old_row ->> 'employee_group_id') is distinct from (v_new_row ->> 'employee_group_id');
    else
      v_identity_changed := (v_old_row ->> 'company_id') is distinct from (v_new_row ->> 'company_id')
        or (v_old_row ->> 'employee_id') is distinct from (v_new_row ->> 'employee_id')
        or (v_old_row ->> 'org_unit_id') is distinct from (v_new_row ->> 'org_unit_id')
        or (v_old_row ->> 'position_id') is distinct from (v_new_row ->> 'position_id')
        or (v_old_row ->> 'is_primary') is distinct from (v_new_row ->> 'is_primary');
    end if;
  end if;

  for v_period_range in
    select pg_catalog.daterange(rp.period_start, rp.period_end, '[]')
    from public.reporting_periods rp
    where rp.status = 'CLOSED'
  loop
    v_old_intersection := case
      when v_old_company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
        then v_old_range * v_period_range
      else 'empty'::daterange
    end;
    v_new_intersection := case
      when v_new_company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
        then v_new_range * v_period_range
      else 'empty'::daterange
    end;

    if (tg_op = 'INSERT' and not isempty(v_new_intersection))
       or (tg_op = 'DELETE' and not isempty(v_old_intersection))
       or (
         tg_op = 'UPDATE'
         and (
           v_old_intersection is distinct from v_new_intersection
           or (v_identity_changed and (not isempty(v_old_intersection) or not isempty(v_new_intersection)))
         )
       ) then
      raise exception 'Reabre el periodo antes de cambiar una asignacion historica.'
        using errcode = '55000';
    end if;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.prevent_assignment_history_change_on_closed_period()
  from public, anon, authenticated, service_role;

drop trigger if exists payroll_closed_assignment_guard
  on public.employee_group_assignments;
create trigger payroll_closed_assignment_guard
  before insert or update or delete on public.employee_group_assignments
  for each row execute function private.prevent_assignment_history_change_on_closed_period();

drop trigger if exists payroll_closed_assignment_guard
  on public.employee_org_assignments;
create trigger payroll_closed_assignment_guard
  before insert or update or delete on public.employee_org_assignments
  for each row execute function private.prevent_assignment_history_change_on_closed_period();

create or replace function public.guard_payroll_workbook_evidence_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_table_name = 'payroll_workbook_versions' then
    if tg_op = 'DELETE' or old.status in ('ACCEPTED', 'CLOSED_SNAPSHOT') then
      raise exception 'Una version aceptada o cerrada es evidencia inmutable.'
        using errcode = '42501';
    end if;
  elsif tg_table_name = 'payroll_workbook_changes' then
    raise exception 'El detalle de una version de pre-nomina es inmutable.'
      using errcode = '42501';
  elsif tg_table_name = 'payroll_workbook_conflicts' then
    if tg_op = 'DELETE' or old.resolved_at is not null then
      raise exception 'La evidencia historica de conflictos no se elimina ni reescribe.'
        using errcode = '42501';
    end if;
    if new.id is distinct from old.id
       or new.company_id is distinct from old.company_id
       or new.reporting_period_id is distinct from old.reporting_period_id
       or new.stable_key is distinct from old.stable_key
       or new.workera_value is distinct from old.workera_value
       or new.rrhh_value is distinct from old.rrhh_value
       or new.created_at is distinct from old.created_at then
      raise exception 'La identidad y valores originales de un conflicto son inmutables.'
        using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.guard_payroll_workbook_evidence_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists payroll_workbook_versions_evidence_immutable
  on public.payroll_workbook_versions;
create trigger payroll_workbook_versions_evidence_immutable
  before update or delete on public.payroll_workbook_versions
  for each row execute function public.guard_payroll_workbook_evidence_immutable();

drop trigger if exists payroll_workbook_changes_evidence_immutable
  on public.payroll_workbook_changes;
create trigger payroll_workbook_changes_evidence_immutable
  before update or delete on public.payroll_workbook_changes
  for each row execute function public.guard_payroll_workbook_evidence_immutable();

drop trigger if exists payroll_workbook_conflicts_evidence_immutable
  on public.payroll_workbook_conflicts;
create trigger payroll_workbook_conflicts_evidence_immutable
  before update or delete on public.payroll_workbook_conflicts
  for each row execute function public.guard_payroll_workbook_evidence_immutable();

create or replace function private.advance_arcotex_payroll_source_revision(
  p_company_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
begin
  if p_company_id is distinct from
    '0a4c0000-0000-0000-0000-000000000001'::uuid then
    return;
  end if;

  insert into private.payroll_source_revisions as source_revision (
    company_id,
    revision,
    changed_at
  ) values (
    p_company_id,
    1,
    clock_timestamp()
  )
  on conflict (company_id) do update
    set revision = source_revision.revision + 1,
        changed_at = excluded.changed_at;

  perform pg_catalog.set_config(
    'gestora.payroll_source_invalidation',
    'true',
    true
  );
  for v_period_id in
    update public.reporting_periods rp
    set status = 'IN_REVIEW'
    where rp.status = 'READY_TO_CLOSE'
    returning rp.id
  loop
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      auth.uid(),
      'PAYROLL_APPROVAL_INVALIDATED_BY_SOURCE_CHANGE',
      'reporting_periods',
      v_period_id,
      pg_catalog.jsonb_build_object('resulting_status', 'IN_REVIEW')
    );
  end loop;
end;
$$;

revoke all on function private.advance_arcotex_payroll_source_revision(uuid)
  from public, anon, authenticated, service_role;

-- El lock statement-level sucede antes de que UPDATE tome locks de filas. El
-- cierre, la aprobacion y la aceptacion toman el mismo advisory antes de la
-- fila de revision. Asi el fence por fila conserva atomicidad sin invertir el
-- orden de locks. Un statement de cero filas solo toma y libera este lock: no
-- avanza revision ni invalida una aprobacion.
create or replace function private.lock_payroll_source_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  return null;
end;
$$;

revoke all on function private.lock_payroll_source_mutation()
  from public, anon, authenticated, service_role;

-- Un unico trigger sirve para todas las fuentes, pero nunca confia en un
-- company_id entregado aparte. La empresa se deriva de la fila tipada o de su
-- cadena de claves foraneas. Los catalogos que hoy son realmente globales
-- invalidan ARCOTEX solo cuando una fila global cambia de verdad.
create or replace function private.bump_arcotex_payroll_source_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_rows jsonb[];
  v_company_id uuid;
  v_previous_company_id uuid;
  v_arcotex constant uuid := '0a4c0000-0000-0000-0000-000000000001'::uuid;
begin
  if tg_op = 'UPDATE' and to_jsonb(new) = to_jsonb(old) then
    return new;
  end if;

  -- En un cambio de FK o company_id hay dos fuentes afectadas: el tenant que
  -- pierde la fila y el que la recibe. Resolver OLD y NEW evita dejar vigente
  -- una aprobacion del tenant de origen; el helper de avance ignora tenants
  -- distintos de ARCOTEX y el filtro consecutivo evita incrementar dos veces.
  if tg_op = 'INSERT' then
    v_rows := array[to_jsonb(new)];
  elsif tg_op = 'DELETE' then
    v_rows := array[to_jsonb(old)];
  else
    v_rows := array[to_jsonb(old), to_jsonb(new)];
  end if;

  foreach v_row in array v_rows
  loop
    v_company_id := null;

    case
    when tg_table_name in (
      'employee_groups', 'employees', 'sync_runs', 'rule_engine_runs',
      'workera_attendance_events',
      'organization_units', 'employee_org_assignments', 'work_schedules',
      'work_schedule_rules', 'schedule_assignments'
    ) then
      v_company_id := nullif(v_row ->> 'company_id', '')::uuid;

    when tg_table_name in (
      'attendance_records', 'attendance_corrections',
      'attendance_status_records', 'late_arrival_records',
      'early_departure_records', 'overtime_records',
      'employee_daily_bonuses', 'attendance_missing_punch_flags',
      'absence_records', 'supporting_documents', 'employee_time_control_policies',
      'employee_group_assignments', 'employee_birthdays'
    ) then
      select e.company_id into v_company_id
      from public.employees e
      where e.id = nullif(v_row ->> 'employee_id', '')::uuid;

    when tg_table_name = 'medical_license_approvals' then
      select e.company_id into v_company_id
      from public.absence_records ar
      join public.employees e on e.id = ar.employee_id
      where ar.id = nullif(v_row ->> 'absence_record_id', '')::uuid;

    when tg_table_name = 'late_arrival_decisions' then
      select e.company_id into v_company_id
      from public.late_arrival_records r
      join public.employees e on e.id = r.employee_id
      where r.id = nullif(v_row ->> 'late_arrival_record_id', '')::uuid;

    when tg_table_name = 'early_departure_decisions' then
      select e.company_id into v_company_id
      from public.early_departure_records r
      join public.employees e on e.id = r.employee_id
      where r.id = nullif(v_row ->> 'early_departure_record_id', '')::uuid;

    when tg_table_name = 'overtime_decisions' then
      select e.company_id into v_company_id
      from public.overtime_records r
      join public.employees e on e.id = r.employee_id
      where r.id = nullif(v_row ->> 'overtime_record_id', '')::uuid;

    when tg_table_name = 'absence_decisions' then
      select e.company_id into v_company_id
      from public.absence_records r
      join public.employees e on e.id = r.employee_id
      where r.id = nullif(v_row ->> 'absence_record_id', '')::uuid;

    when tg_table_name in ('overtime_policies', 'late_arrival_policies', 'bonus_policies') then
      select g.company_id into v_company_id
      from public.employee_groups g
      where g.id = nullif(v_row ->> 'employee_group_id', '')::uuid;

    when tg_table_name = 'profiles' then
      if exists (
        select 1
        from public.company_memberships cm
        where cm.user_id = nullif(v_row ->> 'id', '')::uuid
          and cm.company_id = v_arcotex
      ) or exists (
        select 1
        from public.overtime_decisions d
        join public.overtime_records r on r.id = d.overtime_record_id
        join public.employees e on e.id = r.employee_id
        where d.decided_by = nullif(v_row ->> 'id', '')::uuid
          and e.company_id = v_arcotex
      ) or exists (
        select 1
        from public.late_arrival_decisions d
        join public.late_arrival_records r on r.id = d.late_arrival_record_id
        join public.employees e on e.id = r.employee_id
        where d.decided_by = nullif(v_row ->> 'id', '')::uuid
          and e.company_id = v_arcotex
      ) or exists (
        select 1
        from public.early_departure_decisions d
        join public.early_departure_records r on r.id = d.early_departure_record_id
        join public.employees e on e.id = r.employee_id
        where d.decided_by = nullif(v_row ->> 'id', '')::uuid
          and e.company_id = v_arcotex
      ) then
        v_company_id := v_arcotex;
      end if;

    when tg_table_name in ('holidays', 'attendance_statuses', 'overtime_types') then
      v_company_id := v_arcotex;

      else
        raise exception 'Fuente de pre-nomina sin estrategia de tenant: %', tg_table_name
          using errcode = '55000';
    end case;

    if v_company_id is distinct from v_previous_company_id then
      perform private.advance_arcotex_payroll_source_revision(v_company_id);
    end if;
    v_previous_company_id := v_company_id;
  end loop;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.bump_arcotex_payroll_source_revision()
  from public, anon, authenticated, service_role;

-- Retira todos los fences statement-level heredados antes de reinstalarlos por
-- fila. Un UPDATE/DELETE de cero filas deja de ser una capacidad de denegacion
-- de servicio, y una fila de otro tenant nunca toca la revision ARCOTEX.
do $drop_source_fences$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles',
    'employee_groups',
    'employee_group_assignments',
    'employees',
    'employee_birthdays',
    'holidays',
    'sync_runs',
    'rule_engine_runs',
    'workera_attendance_events',
    'attendance_records',
    'attendance_corrections',
    'attendance_statuses',
    'attendance_status_records',
    'late_arrival_records',
    'late_arrival_decisions',
    'early_departure_records',
    'early_departure_decisions',
    'overtime_types',
    'overtime_policies',
    'late_arrival_policies',
    'overtime_records',
    'overtime_decisions',
    'bonus_policies',
    'employee_daily_bonuses',
    'attendance_missing_punch_flags',
    'absence_records',
    'absence_decisions',
    'medical_license_approvals',
    'supporting_documents',
    'organization_units',
    'employee_org_assignments',
    'work_schedules',
    'work_schedule_rules',
    'schedule_assignments',
    'employee_time_control_policies',
    'payroll_workbook_conflicts'
  ]
  loop
    execute pg_catalog.format(
      'drop trigger if exists payroll_source_revision_fence on public.%I',
      v_table
    );
    execute pg_catalog.format(
      'drop trigger if exists payroll_source_revision_lock on public.%I',
      v_table
    );
  end loop;
end;
$drop_source_fences$;

do $create_source_locks$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles',
    'employee_groups',
    'employee_group_assignments',
    'employees',
    'employee_birthdays',
    'holidays',
    'sync_runs',
    'rule_engine_runs',
    'workera_attendance_events',
    'attendance_records',
    'attendance_corrections',
    'attendance_statuses',
    'attendance_status_records',
    'late_arrival_records',
    'late_arrival_decisions',
    'early_departure_records',
    'early_departure_decisions',
    'overtime_types',
    'overtime_policies',
    'late_arrival_policies',
    'overtime_records',
    'overtime_decisions',
    'bonus_policies',
    'employee_daily_bonuses',
    'attendance_missing_punch_flags',
    'absence_records',
    'absence_decisions',
    'medical_license_approvals',
    'supporting_documents',
    'organization_units',
    'employee_org_assignments',
    'work_schedules',
    'work_schedule_rules',
    'schedule_assignments',
    'employee_time_control_policies',
    'payroll_workbook_conflicts'
  ]
  loop
    execute pg_catalog.format(
      'create trigger payroll_source_revision_lock '
      || 'before insert or update or delete on public.%I '
      || 'for each statement execute function private.lock_payroll_source_mutation()',
      v_table
    );
  end loop;
end;
$create_source_locks$;

do $create_source_fences$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles',
    'employee_groups',
    'employee_group_assignments',
    'employees',
    'employee_birthdays',
    'holidays',
    'sync_runs',
    'rule_engine_runs',
    'workera_attendance_events',
    'attendance_records',
    'attendance_corrections',
    'attendance_statuses',
    'attendance_status_records',
    'late_arrival_records',
    'late_arrival_decisions',
    'early_departure_records',
    'early_departure_decisions',
    'overtime_types',
    'overtime_policies',
    'late_arrival_policies',
    'overtime_records',
    'overtime_decisions',
    'bonus_policies',
    'employee_daily_bonuses',
    'attendance_missing_punch_flags',
    'absence_records',
    'absence_decisions',
    'medical_license_approvals',
    'supporting_documents',
    'organization_units',
    'employee_org_assignments',
    'work_schedules',
    'work_schedule_rules',
    'schedule_assignments',
    'employee_time_control_policies'
  ]
  loop
    execute pg_catalog.format(
      'create trigger payroll_source_revision_fence '
      || 'before insert or update or delete on public.%I '
      || 'for each row execute function private.bump_arcotex_payroll_source_revision()',
      v_table
    );
  end loop;
end;
$create_source_fences$;

-- Los conflictos resueltos son historia del XLSX, no una fuente viva. Solo
-- cambiar el conjunto o contenido de conflictos abiertos invalida readiness.
create or replace function private.bump_payroll_revision_for_open_conflict()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_open boolean := tg_op <> 'INSERT' and old.resolved_at is null;
  v_new_open boolean := tg_op <> 'DELETE' and new.resolved_at is null;
  v_company_id uuid := case when tg_op = 'DELETE' then old.company_id else new.company_id end;
begin
  if (tg_op = 'INSERT' and v_new_open)
     or (tg_op = 'DELETE' and v_old_open)
     or (
       tg_op = 'UPDATE'
       and (v_old_open is distinct from v_new_open or (v_new_open and to_jsonb(new) <> to_jsonb(old)))
     ) then
    perform private.advance_arcotex_payroll_source_revision(v_company_id);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.bump_payroll_revision_for_open_conflict()
  from public, anon, authenticated, service_role;

create trigger payroll_source_revision_fence
  before insert or update or delete on public.payroll_workbook_conflicts
  for each row execute function private.bump_payroll_revision_for_open_conflict();

-- cleanup_demo_data() elimina primero todas las filas dependientes y deja
-- employees para el final. Si encuentra un empleado demo de ARCOTEX mientras
-- existe cualquier periodo CLOSED, esta excepcion revierte atomicamente la
-- llamada completa y evita que la utilidad de staging eluda la reapertura.
create or replace function private.prevent_arcotex_demo_cleanup_while_closed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if old.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
     and old.source = 'demo'
     and exists (
       select 1
       from public.reporting_periods rp
       where rp.status = 'CLOSED'
         and coalesce(
           to_jsonb(rp) ->> 'company_id',
           '0a4c0000-0000-0000-0000-000000000001'
         ) = '0a4c0000-0000-0000-0000-000000000001'
     ) then
    raise exception 'No se pueden limpiar datos demo de ARCOTEX con periodos cerrados; reabre primero.'
      using errcode = '55000';
  end if;

  return old;
end;
$$;

revoke all on function private.prevent_arcotex_demo_cleanup_while_closed()
  from public, anon, authenticated, service_role;

drop trigger if exists employees_prevent_demo_cleanup_while_closed
  on public.employees;
create trigger employees_prevent_demo_cleanup_while_closed
  before delete on public.employees
  for each row execute function private.prevent_arcotex_demo_cleanup_while_closed();

-- Una version nueva requiere volver a IN_REVIEW antes de aceptarla. De este
-- modo READY_TO_CLOSE siempre queda ligado a exactamente la version que RR.HH.
-- aprobo, y CLOSED sigue siendo inmutable hasta una reapertura formal.
create or replace function public.prevent_payroll_workbook_acceptance_while_closed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_period_status public.reporting_period_status;
begin
  if new.status = 'ACCEPTED' then
    select rp.status into v_period_status
    from public.reporting_periods rp
    where rp.id = new.reporting_period_id;

    if v_period_status in ('READY_TO_CLOSE', 'CLOSED') then
      raise exception 'Devuelve el periodo a revision antes de aceptar otra version de pre-nomina.'
        using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_payroll_workbook_acceptance_while_closed()
  from public, anon, authenticated, service_role;

-- Whitelist universal de estados. La RLS decide quien puede solicitar un
-- cambio; este trigger impide que incluso el dueno o service_role salten la
-- maquina de estados sin el protocolo confiable correspondiente.
create or replace function private.assert_payroll_rule_engine_fresh(
  p_company_id uuid,
  p_period_start date,
  p_period_end date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_date date;
  v_sync public.sync_runs%rowtype;
  v_rule public.rule_engine_runs%rowtype;
  v_current_input_revision bigint;
  v_current_day_input_revision bigint;
  v_sync_required_from date;
begin
  select r.revision into v_current_input_revision
  from private.attendance_engine_input_revisions r
  where r.company_id = p_company_id;
  select r.required_from into v_sync_required_from
  from private.workera_sync_requirements r
  where r.company_id = p_company_id;

  for v_date in
    select day::date
    from pg_catalog.generate_series(p_period_start, p_period_end, interval '1 day') day
  loop
    v_sync := null;
    v_rule := null;

    select sr.* into v_sync
    from public.sync_runs sr
    where sr.company_id = p_company_id
      and v_date between sr.target_period_start and sr.target_period_end
    order by sr.started_at desc, sr.id desc
    limit 1;

    -- Los períodos anteriores a la fecha explícita de adopción conservan el
    -- flujo histórico/manual. Desde esa fecha, omitir por completo un día de
    -- sincronización es un bloqueo, no una señal de ausencia de datos.
    if v_sync.id is null then
      if v_sync_required_from is not null and v_date >= v_sync_required_from then
        raise exception 'Falta sincronizar Workera para el %.', v_date
          using errcode = '55000';
      end if;
      continue;
    end if;
    if v_sync.status <> 'SUCCEEDED' or v_sync.finished_at is null then
      raise exception 'La sincronizacion Workera del % no termino correctamente.', v_date
        using errcode = '55000';
    end if;

    select rr.* into v_rule
    from public.rule_engine_runs rr
    where rr.company_id = p_company_id and rr.work_date = v_date
    order by rr.started_at desc, rr.id desc
    limit 1;

    select r.revision into v_current_day_input_revision
    from private.attendance_engine_day_input_revisions r
    where r.company_id = p_company_id and r.work_date = v_date;
    v_current_day_input_revision := coalesce(v_current_day_input_revision, 0);

    if v_rule.id is null
       or v_rule.status <> 'SUCCEEDED'
       or v_rule.finished_at is null
       or v_rule.failure_count <> 0
       or v_rule.without_schedule <> 0
       -- Incluso un retry "UNCHANGED" sucede después de un intento que pudo
       -- publicar eventos antes de caer. Por eso el motor siempre debe ser
       -- posterior al último SUCCEEDED, sin depender de sus contadores.
       or v_rule.finished_at < v_sync.finished_at
       -- Un cambio de horario, política, feriado, grupo, trabajador,
       -- corrección o marcación invalida la corrida aunque no exista un sync
       -- más nuevo. La revisión se captura al abrir el lease y se vuelve a
       -- comprobar atómicamente al cerrarlo.
       or v_rule.input_revision is distinct from v_current_input_revision
       or v_rule.day_input_revision is distinct from v_current_day_input_revision then
      raise exception 'El motor de asistencia del % no esta conciliado con la ultima sincronizacion.', v_date
        using errcode = '55000';
    end if;
  end loop;
end;
$$;

revoke all on function private.assert_payroll_rule_engine_fresh(uuid, date, date)
  from public, anon, authenticated, service_role;

create or replace function public.guard_reporting_period_close_and_reopen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation_id uuid;
  v_trusted_close boolean := false;
  v_trusted_approval boolean := false;
begin
  if new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end then
    raise exception 'El rango de un periodo existente es inmutable; crea otro periodo.'
      using errcode = '42501';
  end if;

  begin
    v_operation_id := nullif(current_setting('gestora.payroll_close_operation', true), '')::uuid;
  exception when invalid_text_representation then
    v_operation_id := null;
  end;

  if v_operation_id is not null then
    select exists (
      select 1
      from private.payroll_period_close_operations o
      where o.id = v_operation_id
        and o.reporting_period_id = old.id
        and o.actor_id = new.closed_by
        and o.status = 'PREPARED'
    ) into v_trusted_close;
  end if;

  v_trusted_approval := coalesce(
    auth.role() = 'service_role'
    and nullif(current_setting('gestora.payroll_ready_approval', true), '') = old.id::text,
    false
  );

  if new.status is distinct from old.status and not (
    (old.status = 'OPEN' and new.status = 'IN_REVIEW')
    or (old.status = 'IN_REVIEW' and new.status in ('OPEN', 'READY_TO_CLOSE'))
    or (old.status = 'READY_TO_CLOSE' and new.status in ('IN_REVIEW', 'CLOSED'))
    or (old.status = 'CLOSED' and new.status = 'REOPENED')
    or (old.status = 'REOPENED' and new.status in ('IN_REVIEW', 'READY_TO_CLOSE'))
  ) then
    raise exception 'La transicion de estado % -> % no esta permitida.', old.status, new.status
      using errcode = '42501';
  end if;

  if new.status = 'READY_TO_CLOSE'
     and old.status <> 'READY_TO_CLOSE'
     and not v_trusted_approval then
    raise exception 'Aprobar una pre-nomina exige una comprobacion conciliada y estable.'
      using errcode = '42501';
  end if;

  if new.status = 'READY_TO_CLOSE' and old.status <> 'READY_TO_CLOSE' then
    perform private.assert_payroll_rule_engine_fresh(
      '0a4c0000-0000-0000-0000-000000000001'::uuid,
      new.period_start,
      new.period_end
    );
  end if;

  if new.status = 'CLOSED' and not v_trusted_close then
    raise exception 'Cerrar un periodo exige una operacion de snapshot verificada.'
      using errcode = '42501';
  end if;

  if old.status = 'READY_TO_CLOSE'
     and new.status not in ('READY_TO_CLOSE', 'CLOSED') then
    update public.reporting_period_approvals a
    set invalidated_at = clock_timestamp(),
        invalidation_reason = case
          when current_setting('gestora.payroll_source_invalidation', true) = 'true'
            then 'DATOS_FUENTE_MODIFICADOS'
          else 'PERIODO_DEVUELTO_A_REVISION'
        end
    where a.reporting_period_id = old.id
      and a.invalidated_at is null;
  end if;

  if old.status = 'CLOSED' then
    perform public.enforce_mfa_for_privileged();
    if not coalesce(public.request_is_aal2(), false) then
      raise exception 'Reabrir un periodo exige segundo factor (MFA).'
        using errcode = '42501';
    end if;
    if new.status <> 'REOPENED'
       or auth.uid() is null
       or new.reopened_by is distinct from auth.uid()
       or new.reopened_at is null
       or new.reopened_at is not distinct from old.reopened_at
       or length(btrim(coalesce(new.reopen_reason, ''))) not between 1 and 2000
       or new.closed_by is distinct from old.closed_by
       or new.closed_at is distinct from old.closed_at then
      raise exception 'Reabrir exige actor, fecha y motivo nuevos, sin alterar la evidencia del cierre.'
        using errcode = '42501';
    end if;

    update public.reporting_period_approvals a
    set invalidated_at = clock_timestamp(),
        invalidation_reason = 'PERIODO_REABIERTO'
    where a.reporting_period_id = old.id
      and a.invalidated_at is null;
  elsif not v_trusted_close and (
    new.closed_by is distinct from old.closed_by
    or new.closed_at is distinct from old.closed_at
  ) then
    raise exception 'La evidencia de cierre no se puede editar directamente.'
      using errcode = '42501';
  end if;

  if not (old.status = 'CLOSED' and new.status = 'REOPENED') and (
    new.reopened_by is distinct from old.reopened_by
    or new.reopened_at is distinct from old.reopened_at
    or new.reopen_reason is distinct from old.reopen_reason
  ) then
    raise exception 'La evidencia de reapertura no se puede editar directamente.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_reporting_period_close_and_reopen()
  from public, anon, authenticated, service_role;

-- Defensa en profundidad del cierre: una operacion PREPARED solo puede nacer
-- para la aprobacion vigente exacta (tenant, periodo, version y revision).
create or replace function private.require_current_payroll_approval_for_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.reporting_period_approvals a
    where a.company_id = new.company_id
      and a.reporting_period_id = new.reporting_period_id
      and a.accepted_workbook_version_id = new.base_version_id
      and a.source_revision = new.source_revision
      and a.invalidated_at is null
  ) then
    raise exception 'El cierre exige la aprobacion RR. HH. vigente de esta version y revision.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.require_current_payroll_approval_for_close()
  from public, anon, authenticated, service_role;

drop trigger if exists payroll_close_operation_requires_current_approval
  on private.payroll_period_close_operations;
create trigger payroll_close_operation_requires_current_approval
  before insert on private.payroll_period_close_operations
  for each row execute function private.require_current_payroll_approval_for_close();
