-- GESTORA Rendiciones Fase 4B: el switch del piloto debe ser autoritativo en
-- PostgreSQL. El flag del proceso web sigue siendo un kill-switch adicional,
-- pero ningún cliente puede saltarse la pausa invocando el RPC directamente.

create or replace function public.enforce_expense_accounting_enqueue_enabled()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_enabled boolean := false;
begin
  select cm.status in ('ENABLED', 'PILOT')
      and cm.settings @> '{"expense_accounting_export_enabled": true}'::jsonb
    into v_enabled
  from public.company_modules cm
  where cm.company_id = new.company_id and cm.module_key = 'expenses'
  for share;

  if not coalesce(v_enabled, false) then
    raise exception 'La integración contable está pausada para esta empresa.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger expense_accounting_exports_enqueue_guard
  before insert on public.expense_accounting_exports
  for each row execute function public.enforce_expense_accounting_enqueue_enabled();

revoke all on function public.enforce_expense_accounting_enqueue_enabled()
  from public, anon, authenticated, service_role;

comment on function public.enforce_expense_accounting_enqueue_enabled() is
  'Falla cerrado si el piloto contable tenant-aware no está habilitado en company_modules.settings.';

create or replace function public.platform_set_expense_accounting_pilot(
  p_company_id uuid,
  p_enabled boolean,
  p_reason text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_previous_enabled boolean;
  v_status public.company_module_status;
begin
  if v_actor_id is null or not coalesce(public.can_manage_platform(), false) then
    raise exception 'Tu rol no permite operar el piloto contable.' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'El estado del piloto contable es obligatorio.' using errcode = '23514';
  end if;
  if p_reason is null
     or char_length(btrim(p_reason)) not between 8 and 240
     or p_reason ~ '[[:cntrl:]]' then
    raise exception 'El motivo debe tener entre 8 y 240 caracteres.' using errcode = '23514';
  end if;

  select
    cm.status,
    cm.settings @> '{"expense_accounting_export_enabled": true}'::jsonb
  into v_status, v_previous_enabled
  from public.company_modules cm
  where cm.company_id = p_company_id and cm.module_key = 'expenses'
  for update;
  if not found then
    raise exception 'Módulo Rendiciones no encontrado para la empresa.' using errcode = 'P0002';
  end if;
  if not coalesce(public.can_manage_platform(), false) then
    raise exception 'Tu rol no permite operar el piloto contable.' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.companies c
    where c.id = p_company_id
      and c.active
      and c.status in ('ACTIVE', 'ONBOARDING')
  ) then
    raise exception 'La empresa debe estar activa para operar el piloto contable.'
      using errcode = '55000';
  end if;
  if p_enabled and v_status not in ('ENABLED', 'PILOT') then
    raise exception 'Rendiciones debe estar habilitado o en piloto antes de activar contabilidad.'
      using errcode = '23514';
  end if;

  update public.company_modules cm
  set settings = jsonb_set(
        cm.settings,
        '{expense_accounting_export_enabled}',
        to_jsonb(p_enabled),
        true
      ),
      settings_version = cm.settings_version + 1
  where cm.company_id = p_company_id and cm.module_key = 'expenses';

  insert into public.platform_audit_log (
    actor_id, company_id, action, target_type, target_id, metadata
  ) values (
    v_actor_id,
    p_company_id,
    'company.expense_accounting_pilot.changed',
    'company_module',
    'expenses:accounting',
    jsonb_build_object(
      'previous_enabled', coalesce(v_previous_enabled, false),
      'enabled', p_enabled,
      'reason', btrim(p_reason)
    )
  );
  return p_enabled;
end;
$$;

revoke all on function public.platform_set_expense_accounting_pilot(uuid, boolean, text)
  from public, anon, service_role;
grant execute on function public.platform_set_expense_accounting_pilot(uuid, boolean, text)
  to authenticated;

comment on function public.platform_set_expense_accounting_pilot(uuid, boolean, text) is
  'Activa o pausa el piloto contable por empresa con control plane, versionado y auditoría atómica.';
