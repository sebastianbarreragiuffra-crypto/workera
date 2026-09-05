-- P0-A: limites distribuidos para mutaciones del control plane.
--
-- Las acciones ya exigen OWNER/ADMIN, AAL2 y RPC autorizados. Este contador
-- agrega proteccion de volumen compartida entre instancias Next.js y una señal
-- auditable ante automatizacion anomala. Nunca reemplaza la autorizacion del
-- RPC de negocio y consume cuota antes de iniciar efectos externos (invitacion
-- o borrado de factores MFA).

create table public.application_action_rate_limits (
  actor_id          uuid not null references public.profiles(id) on delete cascade,
  company_id        uuid references public.companies(id) on delete cascade,
  scope             text not null check (scope in (
    'platform.company.create',
    'platform.invitation.create',
    'platform.invitation.resend',
    'platform.role.assign',
    'platform.module.change',
    'platform.onboarding.change',
    'platform.organization.create',
    'platform.mfa.reset'
  )),
  window_started_at timestamptz not null,
  request_count     integer not null check (request_count between 1 and 122),
  updated_at        timestamptz not null,
  constraint application_action_rate_limits_key
    unique nulls not distinct (actor_id, company_id, scope)
);

comment on table public.application_action_rate_limits is
  'Contadores distribuidos de mutaciones administrativas por actor, empresa '
  'opcional y scope cerrado. No almacena email, input, payload ni secretos.';

alter table public.application_action_rate_limits enable row level security;
revoke all on table public.application_action_rate_limits
  from public, anon, authenticated, service_role;

create or replace function public.consume_platform_action_rate_limit(
  p_scope text,
  p_company_id uuid default null,
  p_resource_id uuid default null
)
returns table (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window_seconds constant integer := 3600;
  v_window_started_at timestamptz;
  v_limit integer;
  v_request_count integer;
begin
  if v_actor_id is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if not coalesce(public.current_actor_satisfies_mfa(), false) then
    raise exception 'Acceso no autorizado.' using errcode = '42501';
  end if;

  case p_scope
    when 'platform.company.create' then
      v_limit := 5;
      if p_company_id is not null or p_resource_id is not null
         or not coalesce(public.can_manage_platform(), false) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    when 'platform.invitation.create' then
      v_limit := 30;
      if p_company_id is null or p_resource_id is not null
         or not coalesce(public.can_manage_platform(), false)
         or not exists (select 1 from public.companies c where c.id=p_company_id) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    when 'platform.invitation.resend' then
      v_limit := 30;
      if p_company_id is null or p_resource_id is null
         or not coalesce(public.can_manage_platform(), false)
         or not exists (
           select 1 from public.company_invitations i
           where i.id=p_resource_id and i.company_id=p_company_id
         ) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    when 'platform.role.assign' then
      v_limit := 30;
      if p_company_id is null or p_resource_id is null
         or not coalesce(public.can_manage_platform(), false)
         or not exists (
           select 1 from public.company_memberships m
           where m.id=p_resource_id and m.company_id=p_company_id
         ) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    when 'platform.module.change' then
      v_limit := 60;
      if p_company_id is null or p_resource_id is not null
         or not coalesce(public.can_manage_platform(), false)
         or not exists (select 1 from public.companies c where c.id=p_company_id) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    when 'platform.onboarding.change' then
      v_limit := 120;
      if p_company_id is null or p_resource_id is not null
         or not coalesce(public.can_manage_platform(), false)
         or not exists (select 1 from public.companies c where c.id=p_company_id) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    when 'platform.organization.create' then
      v_limit := 60;
      if p_company_id is null or p_resource_id is not null
         or not coalesce(public.can_manage_platform(), false)
         or not exists (select 1 from public.companies c where c.id=p_company_id) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    when 'platform.mfa.reset' then
      v_limit := 10;
      if p_company_id is not null or p_resource_id is null
         or not coalesce(public.can_reset_mfa_for(p_resource_id), false) then
        raise exception 'Acceso no autorizado.' using errcode = '42501';
      end if;

    else
      raise exception 'Superficie no permitida.' using errcode = '22023';
  end case;

  v_window_started_at := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from v_now) / v_window_seconds)
      * v_window_seconds
  );

  insert into public.application_action_rate_limits as limits (
    actor_id, company_id, scope, window_started_at, request_count, updated_at
  ) values (
    v_actor_id, p_company_id, p_scope, v_window_started_at, 1, v_now
  )
  on conflict on constraint application_action_rate_limits_key do update
  set window_started_at = excluded.window_started_at,
      request_count = case
        when limits.window_started_at <> excluded.window_started_at then 1
        else least(limits.request_count + 1, v_limit + 2)
      end,
      updated_at = excluded.updated_at
  returning limits.window_started_at, limits.request_count
  into v_window_started_at, v_request_count;

  allowed := v_request_count <= v_limit;
  request_limit := v_limit;
  remaining := greatest(v_limit - v_request_count, 0);
  retry_after_seconds := case when allowed then 0 else
    greatest(
      pg_catalog.ceil(extract(epoch from (
        v_window_started_at
        + pg_catalog.make_interval(secs => v_window_seconds)
        - v_now
      )))::integer,
      1
    )
  end;

  -- Los RPC de negocio registran cada cambio exitoso. Aqui solo se agrega una
  -- señal por ventana al bloquear para no duplicar ni amplificar la auditoria.
  if v_request_count = v_limit + 1 then
    insert into public.platform_audit_log (
      actor_id, company_id, action, target_type, target_id, metadata
    ) values (
      v_actor_id,
      p_company_id,
      'platform.action.rate_limited',
      p_scope,
      p_resource_id::text,
      pg_catalog.jsonb_build_object(
        'request_count', v_request_count,
        'request_limit', v_limit,
        'retry_after_seconds', retry_after_seconds
      )
    );
  end if;

  return next;
end;
$$;

comment on function public.consume_platform_action_rate_limit(text, uuid, uuid) is
  'Autoriza actor/empresa/recurso para un scope cerrado y consume una cuota '
  'horaria compartida antes de una mutacion del control plane. Un bloqueo deja '
  'una unica señal por ventana; el RPC de negocio audita el cambio real.';

revoke all on function public.consume_platform_action_rate_limit(text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_platform_action_rate_limit(text, uuid, uuid)
  to authenticated;
