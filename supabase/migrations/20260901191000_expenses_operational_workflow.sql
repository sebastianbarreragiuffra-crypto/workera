-- GESTORA Rendiciones EX-2: numeración, configuración inicial y envío seguro
-- de borradores. El flujo sigue siendo independiente de workspace_enabled.

create table public.expense_report_sequences (
  company_id uuid primary key references public.companies(id) on delete cascade,
  next_value bigint not null default 1 check (next_value > 0)
);

alter table public.expense_reports add column reference_number text;

with numbered as (
  select id, company_id,
    row_number() over (partition by company_id order by created_at, id) as sequence_number
  from public.expense_reports
)
update public.expense_reports er
set reference_number = 'RND-' || extract(year from er.created_at)::integer::text || '-' || lpad(numbered.sequence_number::text, 6, '0')
from numbered
where numbered.id = er.id;

insert into public.expense_report_sequences (company_id, next_value)
select company_id, count(*) + 1
from public.expense_reports
group by company_id
on conflict (company_id) do update set next_value = excluded.next_value;

alter table public.expense_reports
  alter column reference_number set not null,
  alter column reference_number set default '',
  add constraint expense_reports_company_reference_key unique (company_id, reference_number);

create or replace function public.assign_expense_report_reference()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence bigint;
begin
  insert into public.expense_report_sequences (company_id, next_value)
  values (new.company_id, 2)
  on conflict (company_id) do update
    set next_value = public.expense_report_sequences.next_value + 1
  returning next_value - 1 into v_sequence;

  new.reference_number := 'RND-' || extract(year from current_date)::integer::text
    || '-' || lpad(v_sequence::text, 6, '0');
  return new;
end;
$$;

revoke all on function public.assign_expense_report_reference() from public, anon, authenticated;

create trigger expense_reports_assign_reference
  before insert on public.expense_reports
  for each row execute function public.assign_expense_report_reference();

create or replace function public.provision_expense_defaults(p_company_id uuid, p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.companies c where c.id = p_company_id and c.active
  ) then
    raise exception 'Empresa inexistente o inactiva.' using errcode = '23503';
  end if;
  if p_actor_id is null or not exists (
    select 1 from public.profiles p where p.id = p_actor_id and p.active
  ) then
    raise exception 'Actor inexistente o inactivo.' using errcode = '23503';
  end if;

  insert into public.expense_categories (
    company_id, code, name, requires_receipt
  ) values
    (p_company_id, 'ALIMENTACION', 'Alimentación', true),
    (p_company_id, 'ALOJAMIENTO', 'Alojamiento', true),
    (p_company_id, 'MOVILIZACION', 'Movilización', true),
    (p_company_id, 'PEAJES', 'Peajes y estacionamientos', true),
    (p_company_id, 'OTROS', 'Otros', false)
  on conflict (company_id, code) do nothing;

  if not exists (
    select 1 from public.expense_policies ep
    where ep.company_id = p_company_id and ep.active
  ) then
    insert into public.expense_policies (
      company_id, name, currency_code, rules, created_by
    ) values (
      p_company_id,
      'Política general',
      'CLP',
      jsonb_build_object(
        'receipt_required_from', 1,
        'duplicate_detection', true,
        'approval_mode', 'MANAGER'
      ),
      p_actor_id
    );
  end if;
end;
$$;

revoke all on function public.provision_expense_defaults(uuid, uuid) from public, anon, authenticated;

-- Completa configuraciones de cualquier empresa que haya activado el módulo
-- antes de esta migración.
do $$
declare
  v_company_id uuid;
  v_actor_id uuid;
begin
  for v_company_id, v_actor_id in
    select cm.company_id, cm.enabled_by
    from public.company_modules cm
    where cm.module_key = 'expenses'
      and cm.status in ('ENABLED', 'PILOT')
      and cm.enabled_by is not null
  loop
    perform public.provision_expense_defaults(v_company_id, v_actor_id);
  end loop;
end;
$$;

create or replace function public.submit_expense_report(p_report_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_submitted_by uuid;
  v_status public.expense_report_status;
  v_total numeric(16,2);
  v_item_count integer;
begin
  if v_actor_id is null then
    raise exception 'Se requiere una sesión autenticada.' using errcode = '42501';
  end if;
  if p_report_id is null then
    raise exception 'report_id es obligatorio.' using errcode = '22004';
  end if;

  select er.company_id, er.submitted_by, er.status, er.total_amount
    into v_company_id, v_submitted_by, v_status, v_total
  from public.expense_reports er
  where er.id = p_report_id
  for update;

  if not found then
    raise exception 'Rendición inexistente.' using errcode = '23503';
  end if;
  if not public.company_has_module(v_company_id, 'expenses')
     or not public.is_active_company_member(v_company_id) then
    raise exception 'Rendiciones no está habilitado para esta membresía.' using errcode = '42501';
  end if;
  if v_submitted_by <> v_actor_id
     and not public.has_company_permission(v_company_id, 'expenses.manage') then
    raise exception 'No puedes enviar una rendición de otra persona.' using errcode = '42501';
  end if;
  if not public.has_company_permission(v_company_id, 'expenses.submit')
     and not public.has_company_permission(v_company_id, 'expenses.manage') then
    raise exception 'Tu rol no permite enviar rendiciones.' using errcode = '42501';
  end if;
  if v_status <> 'DRAFT' then
    raise exception 'Solo se puede enviar una rendición en borrador.' using errcode = '23514';
  end if;

  select count(*)::integer into v_item_count
  from public.expense_items ei
  where ei.company_id = v_company_id and ei.report_id = p_report_id;

  if v_item_count = 0 or v_total <= 0 then
    raise exception 'Agrega al menos un gasto con monto mayor a cero antes de enviar.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.expense_items ei
    where ei.company_id = v_company_id and ei.report_id = p_report_id
      and ei.currency_code <> (
        select er.currency_code from public.expense_reports er where er.id = p_report_id
      )
  ) then
    raise exception 'Todos los gastos deben usar la moneda de la rendición.' using errcode = '23514';
  end if;

  update public.expense_reports er
  set status = 'SUBMITTED', submitted_at = pg_catalog.clock_timestamp()
  where er.company_id = v_company_id and er.id = p_report_id;
end;
$$;

revoke all on function public.submit_expense_report(uuid) from public, anon;
grant execute on function public.submit_expense_report(uuid) to authenticated;

create or replace function public.expense_dashboard_summary(p_company_id uuid)
returns table (
  draft_count bigint,
  review_count bigint,
  approved_count bigint,
  visible_total numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_can_read_all boolean;
begin
  if v_actor_id is null
     or not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id) then
    raise exception 'No tienes acceso a Rendiciones en esta empresa.' using errcode = '42501';
  end if;

  v_can_read_all := public.has_company_permission(p_company_id, 'expenses.read')
    or public.has_company_permission(p_company_id, 'expenses.approve')
    or public.has_company_permission(p_company_id, 'expenses.manage');

  return query
  select
    count(*) filter (where er.status = 'DRAFT'),
    count(*) filter (where er.status in ('SUBMITTED', 'IN_REVIEW')),
    count(*) filter (where er.status in ('APPROVED', 'PAID')),
    coalesce(sum(er.total_amount), 0)
  from public.expense_reports er
  where er.company_id = p_company_id
    and (v_can_read_all or er.submitted_by = v_actor_id);
end;
$$;

revoke all on function public.expense_dashboard_summary(uuid) from public, anon;
grant execute on function public.expense_dashboard_summary(uuid) to authenticated;

revoke all on table public.expense_report_sequences from public, anon, authenticated, service_role;

-- Rendiciones es el único módulo de un workspace legacy que ya puede cambiar
-- estado porque sus rutas y RLS consumen el entitlement de forma integral.
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

comment on function public.submit_expense_report(uuid) is
  'Envía un borrador propio a revisión tras validar tenant, entitlement, permiso, ítems y moneda; el cambio queda auditado por trigger.';
comment on function public.expense_dashboard_summary(uuid) is
  'KPIs agregados y tenant-aware de Rendiciones; evita descargar el historial completo para contar en la aplicación.';
