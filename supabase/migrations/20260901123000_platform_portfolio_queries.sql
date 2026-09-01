-- GESTORA MT-3A -- consultas agregadas y paginadas del portafolio.
--
-- El control plane no debe descargar la cartera completa ni filas laborales
-- para construir indicadores. Estas proyecciones entregan únicamente datos de
-- empresa y conteos agregados, con autorización interna y paginación acotada.

create or replace function public.platform_company_portfolio_page(
  p_search text default null,
  p_status public.company_lifecycle_status default null,
  p_company_id uuid default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  company_id uuid,
  name text,
  slug text,
  legal_name text,
  status public.company_lifecycle_status,
  workspace_enabled boolean,
  plan_code text,
  created_at timestamptz,
  total_members bigint,
  active_members bigint,
  enabled_modules bigint,
  available_modules bigint,
  completed_steps bigint,
  total_steps bigint,
  next_step_label text,
  employee_count bigint,
  onboarding_blocked boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_search text := nullif(pg_catalog.btrim(p_search), '');
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'Acceso exclusivo del control plane.' using errcode = '42501';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'p_limit debe estar entre 1 y 100.' using errcode = '22023';
  end if;

  if p_offset is null or p_offset < 0 then
    raise exception 'p_offset debe ser mayor o igual a 0.' using errcode = '22023';
  end if;

  if v_search is not null and pg_catalog.char_length(v_search) > 160 then
    raise exception 'p_search no puede superar 160 caracteres.' using errcode = '22023';
  end if;

  return query
  with filtered_companies as materialized (
    select
      c.id,
      c.name,
      c.slug,
      c.legal_name,
      c.status,
      c.workspace_enabled,
      c.plan_code,
      c.created_at
    from public.companies c
    where (p_status is null or c.status = p_status)
      and (p_company_id is null or c.id = p_company_id)
      and (
        v_search is null
        or pg_catalog.strpos(pg_catalog.lower(c.name), pg_catalog.lower(v_search)) > 0
        or pg_catalog.strpos(pg_catalog.lower(c.slug), pg_catalog.lower(v_search)) > 0
        or pg_catalog.strpos(
          pg_catalog.lower(coalesce(c.legal_name, '')),
          pg_catalog.lower(v_search)
        ) > 0
      )
  ),
  page_companies as (
    select
      fc.*,
      pg_catalog.count(*) over () as page_total_count
    from filtered_companies fc
    order by fc.created_at desc, fc.name, fc.id
    limit p_limit
    offset p_offset
  )
  select
    pc.id,
    pc.name,
    pc.slug,
    pc.legal_name,
    pc.status,
    pc.workspace_enabled,
    pc.plan_code,
    pc.created_at,
    (
      select pg_catalog.count(*)
      from public.company_memberships cm
      where cm.company_id = pc.id
    ),
    (
      select pg_catalog.count(*)
      from public.company_memberships cm
      join public.profiles p on p.id = cm.user_id
      where cm.company_id = pc.id
        and cm.active
        and p.active
    ),
    (
      select pg_catalog.count(*)
      from public.company_modules cm
      join public.module_catalog mc on mc.key = cm.module_key and mc.active
      where cm.company_id = pc.id
        and cm.status in ('ENABLED', 'PILOT')
    ),
    (
      select pg_catalog.count(*)
      from public.company_modules cm
      join public.module_catalog mc on mc.key = cm.module_key and mc.active
      where cm.company_id = pc.id
    ),
    (
      select pg_catalog.count(*)
      from public.company_onboarding_steps os
      join public.onboarding_step_catalog osc on osc.key = os.step_key and osc.active
      where os.company_id = pc.id
        and os.status = 'COMPLETE'
    ),
    (
      select pg_catalog.count(*)
      from public.company_onboarding_steps os
      join public.onboarding_step_catalog osc on osc.key = os.step_key and osc.active
      where os.company_id = pc.id
    ),
    (
      select osc.name
      from public.company_onboarding_steps os
      join public.onboarding_step_catalog osc on osc.key = os.step_key and osc.active
      where os.company_id = pc.id
        and os.status <> 'COMPLETE'
      order by osc.sort_order, osc.key
      limit 1
    ),
    (
      select pg_catalog.count(*)
      from public.employees e
      where e.company_id = pc.id
        and e.active
    ),
    exists (
      select 1
      from public.company_onboarding_steps os
      join public.onboarding_step_catalog osc on osc.key = os.step_key and osc.active
      where os.company_id = pc.id
        and os.status = 'BLOCKED'
    ),
    pc.page_total_count
  from page_companies pc
  order by pc.created_at desc, pc.name, pc.id;
end;
$$;

comment on function public.platform_company_portfolio_page(
  text, public.company_lifecycle_status, uuid, integer, integer
) is
  'Portafolio paginado del control plane. Busca por nombre/slug/razón social y devuelve solo conteos agregados, nunca filas laborales ni secretos.';

create or replace function public.platform_portfolio_summary()
returns table (
  total_companies bigint,
  active_companies bigint,
  onboarding_companies bigint,
  active_members bigint,
  enabled_modules bigint,
  pending_invitations bigint,
  setup_required_modules bigint,
  blocked_onboarding_companies bigint,
  suspended_companies bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_platform_admin() then
    raise exception 'Acceso exclusivo del control plane.' using errcode = '42501';
  end if;

  return query
  select
    (select pg_catalog.count(*) from public.companies c),
    (
      select pg_catalog.count(*)
      from public.companies c
      where c.status = 'ACTIVE'
    ),
    (
      select pg_catalog.count(*)
      from public.companies c
      where c.status = 'ONBOARDING'
    ),
    (
      select pg_catalog.count(*)
      from public.company_memberships cm
      join public.profiles p on p.id = cm.user_id
      where cm.active and p.active
    ),
    (
      select pg_catalog.count(*)
      from public.company_modules cm
      join public.module_catalog mc on mc.key = cm.module_key and mc.active
      where cm.status in ('ENABLED', 'PILOT')
    ),
    (
      select pg_catalog.count(*)
      from public.company_invitations ci
      where ci.status = 'PENDING'
        and ci.expires_at > pg_catalog.now()
    ),
    (
      select pg_catalog.count(*)
      from public.company_modules cm
      join public.module_catalog mc on mc.key = cm.module_key and mc.active
      where cm.status = 'SETUP_REQUIRED'
    ),
    (
      select pg_catalog.count(distinct os.company_id)
      from public.company_onboarding_steps os
      join public.onboarding_step_catalog osc on osc.key = os.step_key and osc.active
      where os.status = 'BLOCKED'
    ),
    (
      select pg_catalog.count(*)
      from public.companies c
      where c.status = 'SUSPENDED'
    );
end;
$$;

comment on function public.platform_portfolio_summary() is
  'KPIs agregados del portafolio para el dashboard global. No expone nombres de personas, emails, settings ni payloads operacionales.';

revoke all on function public.platform_company_portfolio_page(
  text, public.company_lifecycle_status, uuid, integer, integer
) from public, anon, authenticated;
revoke all on function public.platform_portfolio_summary()
  from public, anon, authenticated;

grant execute on function public.platform_company_portfolio_page(
  text, public.company_lifecycle_status, uuid, integer, integer
) to authenticated;
grant execute on function public.platform_portfolio_summary()
  to authenticated;
