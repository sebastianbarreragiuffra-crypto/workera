-- P0-A: extender la cuota distribuida del control plane a mutaciones de
-- Rendiciones y del workspace laboral ARCOTEX.
--
-- El contador sigue siendo una sola primitiva PostgreSQL compartida entre
-- instancias. Cada scope valida primero identidad, MFA cuando corresponde,
-- membresía y alcance tenant. La autorización fina (recurso, área, permiso y
-- transición) permanece en la Action/RPC de negocio y nunca se reemplaza por
-- este control de abuso.

alter table public.application_action_rate_limits
  drop constraint application_action_rate_limits_scope_check,
  add constraint application_action_rate_limits_scope_check check (scope in (
    'platform.company.create',
    'platform.invitation.create',
    'platform.invitation.resend',
    'platform.role.assign',
    'platform.module.change',
    'platform.onboarding.change',
    'platform.organization.create',
    'platform.mfa.reset',
    'expenses.workflow.mutate',
    'workforce.review.mutate',
    'workforce.medical.decide',
    'workforce.schedules.manage',
    'workforce.periods.manage',
    'workforce.payroll.manage',
    'workforce.roster.manage',
    'workforce.meals.manage',
    'workforce.rule_engine.run',
    'workforce.sync.rerun'
  ));

alter table public.application_action_rate_limits
  drop constraint application_action_rate_limits_request_count_check,
  add constraint application_action_rate_limits_request_count_check
    check (request_count between 1 and 242);

comment on table public.application_action_rate_limits is
  'Contadores distribuidos de mutaciones por actor, empresa y scope cerrado. '
  'No almacena email, input, payload, recurso de negocio ni secretos.';

create or replace function public.consume_application_action_rate_limit(
  p_scope text,
  p_company_id uuid default null
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
  v_actor_role public.app_role;
  v_company_id uuid;
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

  select p.role
  into v_actor_role
  from public.profiles p
  where p.id = v_actor_id and p.active;

  if p_scope = 'expenses.workflow.mutate' then
    v_limit := 240;
    v_company_id := p_company_id;
    if v_company_id is null
       or not exists (
         select 1
         from public.companies c
         join public.company_memberships cm
           on cm.company_id = c.id
          and cm.user_id = v_actor_id
          and cm.active
         join public.company_modules modules
           on modules.company_id = c.id
          and modules.module_key = 'expenses'
          and modules.status in ('ENABLED', 'PILOT')
         where c.id = v_company_id and c.active
       ) then
      raise exception 'Acceso no autorizado.' using errcode = '42501';
    end if;
  else
    -- El dominio laboral aún es legacy. El cliente no puede elegir empresa:
    -- se deriva la única permitida y se exige que continúe habilitada.
    if p_company_id is not null then
      raise exception 'Acceso no autorizado.' using errcode = '42501';
    end if;
    select c.id
    into v_company_id
    from public.companies c
    where c.slug = 'arcotex'
      and c.active
      and c.workspace_enabled;

    if v_company_id is null
       or v_actor_role is null
       or not exists (
         select 1
         from public.company_memberships cm
         where cm.company_id = v_company_id
           and cm.user_id = v_actor_id
           and cm.active
       ) then
      raise exception 'Acceso no autorizado.' using errcode = '42501';
    end if;

    case p_scope
      when 'workforce.review.mutate' then
        v_limit := 240;
        -- El área/recurso se autoriza después mediante can_manage_employee.

      when 'workforce.medical.decide' then
        v_limit := 60;
        if v_actor_role not in ('SUPER_ADMIN', 'ADMIN_RRHH') then
          raise exception 'Acceso no autorizado.' using errcode = '42501';
        end if;

      when 'workforce.schedules.manage' then v_limit := 60;
      when 'workforce.periods.manage' then v_limit := 30;
      when 'workforce.payroll.manage' then v_limit := 30;
      when 'workforce.roster.manage' then v_limit := 20;
      when 'workforce.meals.manage' then v_limit := 20;
      when 'workforce.rule_engine.run' then v_limit := 10;
      when 'workforce.sync.rerun' then v_limit := 10;
      else
        raise exception 'Superficie no permitida.' using errcode = '22023';
    end case;

    if p_scope <> 'workforce.review.mutate'
       and p_scope <> 'workforce.medical.decide'
       and v_actor_role not in ('SUPER_ADMIN', 'ADMIN_RRHH') then
      raise exception 'Acceso no autorizado.' using errcode = '42501';
    end if;
  end if;

  v_window_started_at := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from v_now) / v_window_seconds)
      * v_window_seconds
  );

  insert into public.application_action_rate_limits as limits (
    actor_id, company_id, scope, window_started_at, request_count, updated_at
  ) values (
    v_actor_id, v_company_id, p_scope, v_window_started_at, 1, v_now
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

  if v_request_count = v_limit + 1 then
    insert into public.audit_log (
      actor_id, action, entity_type, entity_id, metadata
    ) values (
      v_actor_id,
      'APPLICATION_ACTION_RATE_LIMITED',
      case when p_scope = 'expenses.workflow.mutate'
        then 'EXPENSE_COMPANY' else 'WORKFORCE_COMPANY' end,
      v_company_id,
      pg_catalog.jsonb_build_object(
        'company_id', v_company_id,
        'scope', p_scope,
        'request_count', v_request_count,
        'request_limit', v_limit,
        'retry_after_seconds', retry_after_seconds
      )
    );
  end if;

  return next;
end;
$$;

comment on function public.consume_application_action_rate_limit(text, uuid) is
  'Consume cuota horaria tenant-aware para mutaciones de Rendiciones y del '
  'workspace laboral legacy. Falla cerrado y registra solo el primer bloqueo.';

revoke all on function public.consume_application_action_rate_limit(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_application_action_rate_limit(text, uuid)
  to authenticated;
