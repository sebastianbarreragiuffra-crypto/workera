-- MFA etapa F: exigir aal2 en los RPC sensibles.
--
-- Segunda capa del diseño (docs/MFA_DESIGN.md sección 7). El gate del
-- middleware decide qué páginas se pueden abrir; esto decide qué operaciones
-- se pueden ejecutar, y vive en la base, donde no depende de que el request
-- haya pasado por el middleware.
--
-- ATENCIÓN AL DESPLIEGUE: a diferencia de todo lo anterior, esta migración NO
-- es inerte. `enforce_mfa_for_privileged()` levanta excepción en cuanto la
-- cuenta exige segundo factor y el request llega en aal1, sin consultar
-- `MFA_ENFORCEMENT_ENABLED` -- una función de base de datos no lee variables
-- de entorno, y esa independencia es justamente lo que la hace una segunda
-- capa y no una copia de la primera. Aplicarla antes de que las cuentas
-- privilegiadas hayan inscrito su factor las deja sin aprobar licencias ni
-- administrar la plataforma. Va en el paso 5 del rollout de la sección 8,
-- junto con el flag, no en el paso 1.
--
-- Las funciones se reproducen completas porque `create or replace` exige el
-- cuerpo entero. El único cambio respecto de su versión vigente es la línea
-- `perform public.enforce_mfa_for_privileged();`, agregada inmediatamente
-- después de la validación de rol que cada una ya tenía -- nunca antes: quien
-- no está autorizado debe seguir recibiendo el error de autorización y no uno
-- de MFA, que le revelaría que su rol sí alcanzaba.
--
-- Cada cuerpo se copió de la migración que define la versión VIGENTE de esa
-- función, que no siempre es la que la creó: `platform_set_company_module_status`
-- fue redefinida por EX-2 en 20260901191000 para permitir el módulo `expenses`
-- sin abrir el workspace laboral y para provisionar sus defaults. Copiarla de
-- 20260901121000 habría revertido ambas cosas en silencio.
--
-- Dónde NO se agrega: en los RPC de lectura del portafolio, y en
-- `reconcile_expense_report` y demás RPC de Rendiciones. La guarda deja pasar
-- a quien no exige MFA, así que sería inofensiva, pero solo agrega ruido donde
-- los llamadores legítimos están fuera del conjunto. La regla es agregarla
-- donde TODOS los llamadores legítimos ya están dentro.

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
  v_max_days constant integer := 366;
begin
  if not public.is_medical_license_approver() then
    raise exception 'No autorizado para aprobar licencias médicas.';
  end if;
  perform public.enforce_mfa_for_privileged();
  if p_confirmed_end_date < p_confirmed_start_date then
    raise exception 'La fecha de término no puede ser anterior a la fecha de inicio.';
  end if;
  if (p_confirmed_end_date - p_confirmed_start_date) + 1 > v_max_days then
    raise exception
      'El rango confirmado (% días) supera el máximo de % días para una licencia médica.',
      (p_confirmed_end_date - p_confirmed_start_date) + 1, v_max_days;
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
  perform public.enforce_mfa_for_privileged();
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


create or replace function public.platform_create_company(
  p_name text,
  p_slug text,
  p_legal_name text default null,
  p_primary_contact_name text default null,
  p_primary_contact_email text default null,
  p_plan_code text default 'CUSTOM',
  p_country_code text default 'CL',
  p_timezone text default 'America/Santiago'
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid := gen_random_uuid();
  v_name text := pg_catalog.btrim(p_name);
  v_slug text := pg_catalog.lower(pg_catalog.btrim(p_slug));
  v_legal_name text := nullif(pg_catalog.btrim(p_legal_name), '');
  v_contact_name text := nullif(pg_catalog.btrim(p_primary_contact_name), '');
  v_contact_email text := nullif(pg_catalog.lower(pg_catalog.btrim(p_primary_contact_email)), '');
  v_plan_code text := pg_catalog.upper(pg_catalog.btrim(p_plan_code));
  v_country_code text := pg_catalog.upper(pg_catalog.btrim(p_country_code));
  v_timezone text := pg_catalog.btrim(p_timezone);
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if nullif(v_name, '') is null
     or nullif(v_slug, '') is null
     or nullif(v_plan_code, '') is null
     or nullif(v_country_code, '') is null
     or nullif(v_timezone, '') is null then
    raise exception 'Nombre, slug, plan, pais y zona horaria son obligatorios.'
      using errcode = '22004';
  end if;

  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'El slug debe usar letras minusculas, numeros y guiones simples.'
      using errcode = '22023';
  end if;

  if v_country_code !~ '^[A-Z]{2}$' then
    raise exception 'El codigo de pais debe contener dos letras.'
      using errcode = '22023';
  end if;

  if v_contact_email is not null
     and v_contact_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'El correo de contacto no tiene un formato valido.'
      using errcode = '22023';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_timezone_names tzn
    where tzn.name = v_timezone
  ) then
    raise exception 'Zona horaria desconocida.' using errcode = '22023';
  end if;

  insert into public.companies (
    id,
    name,
    slug,
    legal_name,
    active,
    status,
    workspace_enabled,
    plan_code,
    country_code,
    timezone,
    primary_contact_name,
    primary_contact_email,
    created_by,
    onboarded_at
  ) values (
    v_company_id,
    v_name,
    v_slug,
    coalesce(v_legal_name, v_name),
    true,
    'ONBOARDING',
    false,
    v_plan_code,
    v_country_code,
    v_timezone,
    v_contact_name,
    v_contact_email,
    v_actor_id,
    null
  );

  -- El trigger companies_provision_control_plane crea roles, modulos,
  -- onboarding y la raiz organizacional antes de registrar este evento.
  insert into public.platform_audit_log (
    actor_id,
    company_id,
    action,
    target_type,
    target_id,
    metadata
  ) values (
    v_actor_id,
    v_company_id,
    'company.created',
    'company',
    v_company_id::text,
    pg_catalog.jsonb_build_object(
      'slug', v_slug,
      'plan_code', v_plan_code,
      'workspace_enabled', false
    )
  );

  return v_company_id;
end;
$$;


create or replace function public.platform_assign_company_role(
  p_membership_id uuid,
  p_role_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_member_user_id uuid;
  v_membership_active boolean;
  v_workspace_enabled boolean;
  v_role_company_id uuid;
  v_base_role public.app_role;
  v_role_code text;
  v_role_active boolean;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_membership_id is null or p_role_id is null then
    raise exception 'membership_id y role_id son obligatorios.'
      using errcode = '22004';
  end if;

  -- Bloquear la membresia antes de validar el rol evita que otro cambio
  -- concurrente deje desalineados el rol extensible y el rol legacy.
  select cm.company_id, cm.user_id, cm.active, c.workspace_enabled
    into v_company_id, v_member_user_id, v_membership_active, v_workspace_enabled
  from public.company_memberships cm
  join public.companies c on c.id = cm.company_id
  where cm.id = p_membership_id
  for update of cm;

  if not found then
    raise exception 'Membresia empresarial inexistente.'
      using errcode = '23503';
  end if;

  if not v_membership_active then
    raise exception 'No se puede asignar un rol a una membresia inactiva.'
      using errcode = '23514';
  end if;

  select cr.company_id, cr.base_role, cr.code, cr.active
    into v_role_company_id, v_base_role, v_role_code, v_role_active
  from public.company_roles cr
  where cr.id = p_role_id
  for key share;

  if not found then
    raise exception 'Rol empresarial inexistente.'
      using errcode = '23503';
  end if;

  if v_role_company_id <> v_company_id then
    raise exception 'La membresia y el rol deben pertenecer a la misma empresa.'
      using errcode = '23514';
  end if;

  if not v_role_active then
    raise exception 'No se puede asignar un rol empresarial inactivo.'
      using errcode = '23514';
  end if;

  -- El workspace ARCOTEX todavia autoriza varias rutas mediante
  -- profiles.role. Mientras ese gate legacy exista, un rol puramente RBAC
  -- (sin base_role) no puede representarse sin dejar privilegios obsoletos.
  if v_workspace_enabled and v_base_role is null then
    raise exception 'Un workspace habilitado requiere un rol con compatibilidad legacy.'
      using errcode = '23514';
  end if;

  -- El panel administra un rol principal por membresia. La tabla permite una
  -- evolucion futura a multiples roles, pero este RPC aplica reemplazo total.
  delete from public.company_membership_roles cmr
  where cmr.company_id = v_company_id
    and cmr.membership_id = p_membership_id;

  insert into public.company_membership_roles (
    company_id,
    membership_id,
    role_id,
    assigned_by
  ) values (
    v_company_id,
    p_membership_id,
    p_role_id,
    v_actor_id
  );

  -- profiles.role/company_memberships.role son una compatibilidad temporal.
  -- Un rol sin base_role no inventa equivalencias ni borra el valor legacy.
  if v_base_role is not null then
    update public.company_memberships cm
    set role = v_base_role
    where cm.id = p_membership_id;

    if v_workspace_enabled then
      update public.profiles p
      set role = v_base_role
      where p.id = v_member_user_id;
    end if;
  end if;

  insert into public.platform_audit_log (
    actor_id,
    company_id,
    action,
    target_type,
    target_id,
    metadata
  ) values (
    v_actor_id,
    v_company_id,
    'company.membership_role.assigned',
    'company_membership',
    p_membership_id::text,
    pg_catalog.jsonb_build_object(
      'role_id', p_role_id,
      'role_code', v_role_code,
      'membership_legacy_role_updated', v_base_role is not null,
      'profile_legacy_role_updated', v_workspace_enabled and v_base_role is not null
    )
  );
end;
$$;


create or replace function public.platform_set_company_module_status(
  p_company_id uuid,
  p_module_key text,
  p_status public.company_module_status
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_previous_status public.company_module_status;
  v_catalog_active boolean;
  v_workspace_enabled boolean;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.' using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();
  if p_company_id is null or p_module_key is null or p_status is null then
    raise exception 'company_id, module_key y status son obligatorios.' using errcode = '22004';
  end if;

  select cm.status, mc.active, c.workspace_enabled
    into v_previous_status, v_catalog_active, v_workspace_enabled
  from public.company_modules cm
  join public.module_catalog mc on mc.key = cm.module_key
  join public.companies c on c.id = cm.company_id
  where cm.company_id = p_company_id and cm.module_key = p_module_key
  for update of cm;

  if not found then
    raise exception 'Modulo no provisionado para la empresa.' using errcode = '23503';
  end if;
  if not v_catalog_active and p_status in ('ENABLED', 'PILOT') then
    raise exception 'No se puede habilitar un modulo inactivo del catalogo.' using errcode = '23514';
  end if;
  if v_workspace_enabled and p_module_key <> 'expenses' and p_status <> v_previous_status then
    raise exception 'Los módulos de un workspace operativo no se pueden cambiar hasta completar los gates backend y RLS de MT-3D.' using errcode = '23514';
  end if;

  update public.company_modules cm
  set status = p_status,
      enabled_at = case when p_status in ('ENABLED', 'PILOT')
        then case when v_previous_status in ('ENABLED', 'PILOT') then cm.enabled_at else clock_timestamp() end
        else null end,
      enabled_by = case when p_status in ('ENABLED', 'PILOT') then v_actor_id else null end
  where cm.company_id = p_company_id and cm.module_key = p_module_key;

  if p_module_key = 'expenses' and p_status in ('ENABLED', 'PILOT') then
    perform public.provision_expense_defaults(p_company_id, v_actor_id);
  end if;

  insert into public.platform_audit_log (actor_id, company_id, action, target_type, target_id, metadata)
  values (v_actor_id, p_company_id, 'company.module.status_changed', 'company_module', p_module_key,
    jsonb_build_object('previous_status', v_previous_status, 'status', p_status));
end;
$$;


create or replace function public.platform_set_onboarding_step_completed(
  p_company_id uuid,
  p_step_key text,
  p_completed boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_previous_status public.company_onboarding_status;
  v_next_status public.company_onboarding_status;
  v_workspace_enabled boolean;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_company_id is null or p_step_key is null or p_completed is null then
    raise exception 'company_id, step_key y completed son obligatorios.'
      using errcode = '22004';
  end if;

  select cos.status, c.workspace_enabled
    into v_previous_status, v_workspace_enabled
  from public.company_onboarding_steps cos
  join public.companies c on c.id = cos.company_id
  where cos.company_id = p_company_id
    and cos.step_key = p_step_key
  for update;

  if not found then
    raise exception 'Paso de onboarding no provisionado para la empresa.'
      using errcode = '23503';
  end if;

  if p_completed and p_step_key = 'go_live' and not v_workspace_enabled then
    raise exception 'No se puede completar go_live mientras el workspace permanezca bloqueado.'
      using errcode = '23514';
  end if;

  v_next_status := case
    when p_completed then 'COMPLETE'::public.company_onboarding_status
    else 'NOT_STARTED'::public.company_onboarding_status
  end;

  update public.company_onboarding_steps cos
  set status = v_next_status,
      completed_at = case when p_completed then pg_catalog.clock_timestamp() else null end,
      completed_by = case when p_completed then v_actor_id else null end
  where cos.company_id = p_company_id
    and cos.step_key = p_step_key;

  insert into public.platform_audit_log (
    actor_id,
    company_id,
    action,
    target_type,
    target_id,
    metadata
  ) values (
    v_actor_id,
    p_company_id,
    'company.onboarding_step.status_changed',
    'company_onboarding_step',
    p_step_key,
    pg_catalog.jsonb_build_object(
      'previous_status', v_previous_status,
      'status', v_next_status
    )
  );
end;
$$;


create or replace function public.platform_create_company_invitation(
  p_company_id uuid,
  p_email text,
  p_role_id uuid,
  p_expires_at timestamptz default (pg_catalog.now() + interval '7 days')
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_invitation_id uuid := gen_random_uuid();
  v_email text := nullif(pg_catalog.lower(pg_catalog.btrim(p_email)), '');
  v_role_company_id uuid;
  v_role_code text;
  v_role_active boolean;
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_company_id is null or v_email is null or p_role_id is null or p_expires_at is null then
    raise exception 'company_id, email, role_id y expires_at son obligatorios.'
      using errcode = '22004';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'El correo de invitacion no tiene un formato valido.'
      using errcode = '22023';
  end if;

  if p_expires_at <= pg_catalog.now() then
    raise exception 'La invitacion debe vencer en el futuro.'
      using errcode = '22023';
  end if;

  if not exists (select 1 from public.companies c where c.id = p_company_id) then
    raise exception 'Empresa inexistente.' using errcode = '23503';
  end if;

  select cr.company_id, cr.code, cr.active
    into v_role_company_id, v_role_code, v_role_active
  from public.company_roles cr
  where cr.id = p_role_id
  for key share;

  if not found then
    raise exception 'Rol empresarial inexistente.' using errcode = '23503';
  end if;

  if v_role_company_id <> p_company_id then
    raise exception 'La invitacion y el rol deben pertenecer a la misma empresa.'
      using errcode = '23514';
  end if;

  if not v_role_active then
    raise exception 'No se puede invitar con un rol empresarial inactivo.'
      using errcode = '23514';
  end if;

  -- Una invitación que venció por reloj deja de ocupar el índice parcial.
  -- Esto permite reintentar el mismo correo sin un job de mantenimiento.
  update public.company_invitations ci
  set status = 'EXPIRED'::public.company_invitation_status
  where ci.company_id = p_company_id
    and ci.email = v_email
    and ci.status = 'PENDING'
    and ci.expires_at <= pg_catalog.now();

  insert into public.company_invitations (
    id,
    company_id,
    email,
    role_id,
    status,
    expires_at,
    invited_by
  ) values (
    v_invitation_id,
    p_company_id,
    v_email,
    p_role_id,
    'PENDING',
    p_expires_at,
    v_actor_id
  );

  insert into public.platform_audit_log (
    actor_id,
    company_id,
    action,
    target_type,
    target_id,
    metadata
  ) values (
    v_actor_id,
    p_company_id,
    'company.invitation.created',
    'company_invitation',
    v_invitation_id::text,
    -- El correo queda en la tabla protegida de invitaciones, no en metadata.
    pg_catalog.jsonb_build_object(
      'role_id', p_role_id,
      'role_code', v_role_code,
      'status', 'PENDING'
    )
  );

  return v_invitation_id;
end;
$$;


create or replace function public.platform_create_organization_unit(
  p_company_id uuid,
  p_parent_id uuid,
  p_code text,
  p_name text,
  p_unit_type public.organization_unit_type,
  p_sort_order integer default 0
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_unit_id uuid := gen_random_uuid();
  v_parent_company_id uuid;
  v_parent_active boolean;
  v_code text := pg_catalog.upper(pg_catalog.btrim(p_code));
  v_name text := pg_catalog.btrim(p_name);
begin
  if v_actor_id is null or not public.can_manage_platform() then
    raise exception 'Se requiere un OWNER o ADMIN activo de la plataforma.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if p_company_id is null or p_parent_id is null
     or nullif(v_code, '') is null or nullif(v_name, '') is null
     or p_unit_type is null or p_sort_order is null then
    raise exception 'Empresa, padre, codigo, nombre, tipo y orden son obligatorios.'
      using errcode = '22004';
  end if;

  if p_unit_type = 'COMPANY' then
    raise exception 'La raiz COMPANY ya se provisiona automaticamente.'
      using errcode = '23514';
  end if;

  if v_code !~ '^[A-Z0-9][A-Z0-9_-]*$' then
    raise exception 'El codigo de unidad solo admite mayusculas, numeros, guion y guion bajo.'
      using errcode = '22023';
  end if;

  select ou.company_id, ou.active
    into v_parent_company_id, v_parent_active
  from public.organization_units ou
  where ou.id = p_parent_id
  for key share;

  if not found then
    raise exception 'Unidad padre inexistente.' using errcode = '23503';
  end if;

  if v_parent_company_id <> p_company_id then
    raise exception 'La unidad padre debe pertenecer a la misma empresa.'
      using errcode = '23514';
  end if;

  if not v_parent_active then
    raise exception 'No se puede crear una unidad bajo un padre inactivo.'
      using errcode = '23514';
  end if;

  insert into public.organization_units (
    id,
    company_id,
    parent_id,
    code,
    name,
    unit_type,
    sort_order,
    created_by
  ) values (
    v_unit_id,
    p_company_id,
    p_parent_id,
    v_code,
    v_name,
    p_unit_type,
    p_sort_order,
    v_actor_id
  );

  insert into public.platform_audit_log (
    actor_id,
    company_id,
    action,
    target_type,
    target_id,
    metadata
  ) values (
    v_actor_id,
    p_company_id,
    'company.organization_unit.created',
    'organization_unit',
    v_unit_id::text,
    pg_catalog.jsonb_build_object(
      'code', v_code,
      'unit_type', p_unit_type,
      'parent_id', p_parent_id
    )
  );

  return v_unit_id;
end;
$$;
