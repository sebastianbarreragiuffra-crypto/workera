-- =============================================================================
-- Licencias médicas -- flujo de dos etapas: subir documento -> pendiente de
-- aprobación RRHH -> aprobar (genera L en asistencia) o rechazar (nunca L).
-- =============================================================================
--
-- Reutiliza EXACTAMENTE lo que ya existe: `absence_records` (el registro de
-- ausencia en sí, tipo MEDICAL_LEAVE), `supporting_documents`/bucket privado
-- `supporting-documents` (el documento subido) y `attendance_status_records`
-- (donde vive el código "L" real de asistencia -- Fase 2B, sin poblador
-- hasta ahora). Esta migración SOLO agrega la pieza que faltaba: el estado
-- de aprobación en sí (`medical_license_approvals`) y el poblador de L al
-- aprobar. No se toca ninguna tabla de Workera/sync/overtime/lateness.
--
-- Autorización de aprobar/rechazar: exactamente UNA cuenta (a.caceres@arcotex.cl),
-- nunca "cualquier ADMIN_RRHH" ni SUPER_ADMIN por bypass. El email se usa
-- SOLO en esta migración (capa de aprovisionamiento, igual que
-- `authorized_email_roles` en 20260822100000) -- nunca se compara un email
-- en código de aplicación (`src/app`); el chequeo en tiempo de ejecución es
-- un flag booleano en `profiles`, resuelto server-side vía `auth.uid()`.

-- -----------------------------------------------------------------------------
-- 1) Flag de aprobador -- una sola cuenta marcada true. Deliberadamente NO
--    reutiliza `is_privileged_admin()` (SUPER_ADMIN/ADMIN_RRHH): el encargo es
--    explícito en que ni todos los ADMIN_RRHH ni SUPER_ADMIN deben poder
--    aprobar/rechazar licencias médicas por defecto, y no existe hoy ningún
--    override de emergencia ya definido para este caso puntual -- por eso
--    SUPER_ADMIN NO tiene bypass acá (a diferencia de casi todo el resto del
--    esquema). Documentado explícitamente como decisión, no omisión.

alter table public.profiles
  add column medical_license_approver boolean not null default false;

comment on column public.profiles.medical_license_approver is
  'true SOLO para la cuenta autorizada a aprobar/rechazar licencias médicas '
  '(a.caceres@arcotex.cl). Deliberadamente independiente de role/is_privileged_admin() '
  '-- ni ADMIN_RRHH ni SUPER_ADMIN heredan este permiso automáticamente.';

-- Retroactivo: si la cuenta ya existe (ya inició sesión antes de esta migración).
update public.profiles p
set medical_license_approver = true
from auth.users u
where u.id = p.id and u.email = 'a.caceres@arcotex.cl';

-- Futuro: si la cuenta todavía no existe, se marca al crear su profile (mismo
-- patrón de aprovisionamiento idempotente que `authorized_email_roles` /
-- `handle_new_auth_user`, pero como trigger ADITIVO independiente -- no se
-- modifica esa función existente para no arriesgar el flujo de login/roles ya
-- probado).
create or replace function public.set_medical_license_approver_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  select email into v_email from auth.users where id = new.id;
  if v_email = 'a.caceres@arcotex.cl' then
    update public.profiles set medical_license_approver = true where id = new.id;
  end if;
  return new;
end;
$$;

create trigger profiles_set_medical_license_approver
  after insert on public.profiles
  for each row execute function public.set_medical_license_approver_flag();

create or replace function public.is_medical_license_approver()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select medical_license_approver from public.profiles where id = auth.uid()), false);
$$;

grant execute on function public.is_medical_license_approver() to authenticated;

-- -----------------------------------------------------------------------------
-- 2) Estado de aprobación -- DRAFT es conceptual (antes de subir cualquier
--    documento no existe fila todavía, no se persiste como estado).

create type public.medical_license_approval_status as enum (
  'PENDING_RRHH_APPROVAL',
  'APPROVED',
  'REJECTED'
);

create table public.medical_license_approvals (
  id                      uuid primary key default gen_random_uuid(),

  absence_record_id       uuid not null references public.absence_records(id),
  supporting_document_id  uuid not null references public.supporting_documents(id),

  status                  public.medical_license_approval_status not null default 'PENDING_RRHH_APPROVAL',

  -- Propuestas al subir el documento -- desde la fase de extracción
  -- automática (ver columna extraction_status, migración
  -- 20260827100000) provienen de intentar leer el documento, nunca
  -- ingresadas a mano. El aprobador puede corregirlas; los valores
  -- APROBADOS (confirmed_*) son los únicos que generan asistencia.
  proposed_start_date     date not null,
  proposed_end_date       date not null,

  -- Solo se completan al aprobar -- son los valores AUTORITATIVOS.
  confirmed_start_date    date,
  confirmed_end_date      date,

  uploaded_by             uuid not null references public.profiles(id),
  uploaded_at              timestamptz not null default now(),

  approved_by             uuid references public.profiles(id),
  approved_at             timestamptz,

  rejected_by             uuid references public.profiles(id),
  rejected_at             timestamptz,
  rejection_reason        text,

  is_current              boolean not null default true,
  created_at              timestamptz not null default now(),

  constraint medical_license_approvals_proposed_range_chk check (proposed_end_date >= proposed_start_date),
  constraint medical_license_approvals_confirmed_range_chk check (confirmed_end_date is null or confirmed_end_date >= confirmed_start_date),
  constraint medical_license_approvals_approved_fields_chk check (
    (status = 'APPROVED') = (approved_by is not null and approved_at is not null and confirmed_start_date is not null and confirmed_end_date is not null)
  ),
  constraint medical_license_approvals_rejected_fields_chk check (
    (status = 'REJECTED') = (rejected_by is not null and rejected_at is not null and rejection_reason is not null)
  ),
  constraint medical_license_approvals_rejection_reason_not_blank_chk check (rejection_reason is null or length(trim(rejection_reason)) > 0)
);

comment on table public.medical_license_approvals is
  'Flujo de aprobación de licencias médicas (dos etapas: PENDING_RRHH_APPROVAL '
  '-> APPROVED|REJECTED). Solo aprobado genera asistencia "L" -- ver '
  'approve_medical_license(). Nunca se borra una fila; el trigger de guarda '
  'impide transicionar dos veces o editar campos ya fijados.';

create unique index medical_license_approvals_current_per_absence_idx
  on public.medical_license_approvals (absence_record_id)
  where is_current;

create index medical_license_approvals_status_idx on public.medical_license_approvals (status) where is_current;
create index medical_license_approvals_uploaded_by_idx on public.medical_license_approvals (uploaded_by);

alter table public.medical_license_approvals enable row level security;

-- SELECT: el aprobador ve todo (necesita la cola completa de pendientes sin
-- importar área); is_privileged_admin ve todo (auditoría/soporte); cualquier
-- otro usuario solo ve licencias de empleados que puede gestionar
-- (can_manage_employee, mismo scoping ya usado en absence_records/documents).
create policy medical_license_approvals_select on public.medical_license_approvals
  for select to authenticated
  using (
    public.is_medical_license_approver()
    or public.is_privileged_admin()
    or exists (
      select 1 from public.absence_records ar
      where ar.id = medical_license_approvals.absence_record_id
        and public.can_manage_employee(ar.employee_id)
    )
  );

-- INSERT: se crea SIEMPRE en PENDING_RRHH_APPROVAL, por quien sube el
-- documento, y solo si puede gestionar al empleado del absence_record
-- (mismo criterio que subir a supporting_documents/absence_records manual).
-- Subir NUNCA implica poder aprobar -- por eso este INSERT no depende de
-- is_medical_license_approver().
create policy medical_license_approvals_insert on public.medical_license_approvals
  for insert to authenticated
  with check (
    status = 'PENDING_RRHH_APPROVAL'
    and uploaded_by = auth.uid()
    and exists (
      select 1 from public.absence_records ar
      where ar.id = absence_record_id
        and public.can_manage_employee(ar.employee_id)
    )
  );

-- UPDATE: EXCLUSIVAMENTE el aprobador designado -- ni is_privileged_admin ni
-- ningún otro rol pasa este gate (decisión explícita del encargo, ver
-- comentario de la columna arriba). El trigger de guarda (abajo) restringe
-- además QUÉ transición es válida incluso para el aprobador.
create policy medical_license_approvals_update on public.medical_license_approvals
  for update to authenticated
  using (public.is_medical_license_approver())
  with check (public.is_medical_license_approver());

grant select, insert, update on table public.medical_license_approvals to authenticated;
grant select, insert, update on table public.medical_license_approvals to service_role;

-- -----------------------------------------------------------------------------
-- 3) Guarda de transición -- incluso el aprobador solo puede pasar de
--    PENDING_RRHH_APPROVAL a APPROVED/REJECTED una única vez; ningún otro
--    campo (documento, propuesta original, quién subió) puede editarse
--    después de creada la fila.
create or replace function public.guard_medical_license_approval_update()
returns trigger
language plpgsql
as $$
begin
  if old.status <> 'PENDING_RRHH_APPROVAL' then
    raise exception 'Esta licencia ya fue % y no puede modificarse.', old.status;
  end if;
  if new.status not in ('APPROVED', 'REJECTED') then
    raise exception 'Transición de estado inválida (% -> %).', old.status, new.status;
  end if;
  if new.absence_record_id <> old.absence_record_id
     or new.supporting_document_id <> old.supporting_document_id
     or new.uploaded_by <> old.uploaded_by
     or new.uploaded_at <> old.uploaded_at
     or new.proposed_start_date <> old.proposed_start_date
     or new.proposed_end_date <> old.proposed_end_date then
    raise exception 'Estos campos de la licencia no pueden modificarse.';
  end if;
  return new;
end;
$$;

create trigger medical_license_approvals_guard_update
  before update on public.medical_license_approvals
  for each row execute function public.guard_medical_license_approval_update();

-- -----------------------------------------------------------------------------
-- 4) Aprobar/rechazar -- funciones atómicas (transacción implícita por
--    llamada, mismo criterio que `apply_supplier_master_import` en Nómina de
--    Pago: un evento de negocio discreto e irrepetible debe ser todo-o-nada,
--    a diferencia de un poblador batch reintentable). SECURITY INVOKER
--    (default) -- RLS de esta tabla y de `attendance_status_records` se
--    sigue aplicando con el rol real de quien llama; una violación de RLS
--    revierte toda la función igual que cualquier otro error. NUNCA toca
--    `attendance_records`/`workera_attendance_events` (marcación cruda
--    inmutable) -- solo escribe en `attendance_status_records`, la capa de
--    decisión/estado de aplicación (ver comentario de esa tabla, Fase 2B).

create or replace function public.approve_medical_license(
  p_approval_id uuid,
  p_confirmed_start_date date,
  p_confirmed_end_date date
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_absence_record_id uuid;
  v_employee_id uuid;
  v_l_status_id uuid;
  v_date date;
  v_current_id uuid;
  v_current_version integer;
begin
  if not public.is_medical_license_approver() then
    raise exception 'No autorizado para aprobar licencias médicas.';
  end if;
  if p_confirmed_end_date < p_confirmed_start_date then
    raise exception 'La fecha de término no puede ser anterior a la fecha de inicio.';
  end if;

  select absence_record_id into v_absence_record_id
    from public.medical_license_approvals
    where id = p_approval_id and status = 'PENDING_RRHH_APPROVAL';
  if v_absence_record_id is null then
    raise exception 'La licencia no existe o ya no está pendiente de aprobación.';
  end if;

  select employee_id into v_employee_id from public.absence_records where id = v_absence_record_id;
  select id into v_l_status_id from public.attendance_statuses where code = 'L';
  if v_l_status_id is null then
    raise exception 'No se encontró el código de asistencia "L" en el catálogo.';
  end if;

  v_date := p_confirmed_start_date;
  while v_date <= p_confirmed_end_date loop
    select id, source_version into v_current_id, v_current_version
      from public.attendance_status_records
      where employee_id = v_employee_id and work_date = v_date and is_current;

    if v_current_id is not null then
      update public.attendance_status_records set is_current = false where id = v_current_id;
    end if;

    insert into public.attendance_status_records (
      employee_id, work_date, attendance_status_id, source, source_hash, source_version, created_by, reason
    ) values (
      v_employee_id, v_date, v_l_status_id, 'manual',
      md5(v_employee_id::text || '|' || v_date::text || '|L|' || p_approval_id::text),
      coalesce(v_current_version, 0) + 1,
      auth.uid(),
      'Licencia médica aprobada'
    );

    v_current_id := null;
    v_current_version := null;
    v_date := v_date + 1;
  end loop;

  update public.medical_license_approvals
    set status = 'APPROVED',
        approved_by = auth.uid(),
        approved_at = now(),
        confirmed_start_date = p_confirmed_start_date,
        confirmed_end_date = p_confirmed_end_date
    where id = p_approval_id;
end;
$$;

grant execute on function public.approve_medical_license(uuid, date, date) to authenticated;

create or replace function public.reject_medical_license(
  p_approval_id uuid,
  p_reason text
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if not public.is_medical_license_approver() then
    raise exception 'No autorizado para rechazar licencias médicas.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'El motivo de rechazo es obligatorio.';
  end if;

  update public.medical_license_approvals
    set status = 'REJECTED', rejected_by = auth.uid(), rejected_at = now(), rejection_reason = trim(p_reason)
    where id = p_approval_id and status = 'PENDING_RRHH_APPROVAL';

  if not found then
    raise exception 'La licencia no existe o ya no está pendiente de aprobación.';
  end if;
end;
$$;

grant execute on function public.reject_medical_license(uuid, text) to authenticated;
