-- GESTORA Rendiciones EX-1: dominio financiero multiempresa independiente
-- del workspace laboral legacy. Un entitlement de Rendiciones no habilita
-- asistencia, personas ni ningún otro módulo de la empresa.

create type public.expense_report_status as enum (
  'DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'PAID', 'CANCELLED'
);
create type public.expense_approval_decision as enum ('APPROVED', 'REJECTED', 'RETURNED');
create type public.expense_receipt_status as enum ('NOT_PROVIDED', 'UPLOADED', 'PROCESSING', 'PROCESSED', 'FAILED');

insert into public.permission_definitions (code, module_key, description) values
  ('expenses.submit', 'expenses', 'Crear y enviar rendiciones propias.'),
  ('expenses.read', 'expenses', 'Ver todas las rendiciones de la empresa.'),
  ('expenses.approve', 'expenses', 'Revisar y decidir rendiciones.'),
  ('expenses.configure', 'expenses', 'Configurar políticas y categorías de rendición.')
on conflict (code) do nothing;

-- Completa los roles ya provisionados. Las empresas nuevas reciben estos
-- permisos desde provision_company_control_plane, que cruza el catálogo
-- completo para COMPANY_OWNER.
insert into public.company_role_permissions (company_id, role_id, permission_code)
select cr.company_id, cr.id, pd.code
from public.company_roles cr
join public.permission_definitions pd on pd.module_key = 'expenses'
where cr.code in ('COMPANY_OWNER', 'HR_ADMIN')
on conflict do nothing;

insert into public.company_role_permissions (company_id, role_id, permission_code)
select cr.company_id, cr.id, 'expenses.read'
from public.company_roles cr
where cr.code = 'AUDITOR'
on conflict do nothing;

insert into public.company_role_permissions (company_id, role_id, permission_code)
select cr.company_id, cr.id, 'expenses.submit'
from public.company_roles cr
where cr.code in ('PRODUCTION_SUPERVISOR', 'INSTALLATION_SUPERVISOR')
on conflict do nothing;

create or replace function public.provision_expense_role_permissions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.company_role_permissions (company_id, role_id, permission_code)
  select new.company_id, new.id, pd.code
  from public.permission_definitions pd
  where (new.code in ('COMPANY_OWNER', 'HR_ADMIN') and pd.module_key = 'expenses')
     or (new.code = 'AUDITOR' and pd.code = 'expenses.read')
     or (new.code in ('PRODUCTION_SUPERVISOR', 'INSTALLATION_SUPERVISOR') and pd.code = 'expenses.submit')
  on conflict do nothing;
  return new;
end;
$$;

revoke all on function public.provision_expense_role_permissions() from public, anon, authenticated;

create trigger company_roles_provision_expense_permissions
  after insert on public.company_roles
  for each row execute function public.provision_expense_role_permissions();

create table public.expense_policies (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  name             text not null,
  version          integer not null default 1 check (version > 0),
  currency_code    text not null default 'CLP' check (currency_code ~ '^[A-Z]{3}$'),
  rules            jsonb not null default '{}'::jsonb check (jsonb_typeof(rules) = 'object'),
  active           boolean not null default true,
  created_by       uuid not null references public.profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, name, version)
);

create trigger expense_policies_set_updated_at
  before update on public.expense_policies
  for each row execute function public.set_updated_at();

create table public.expense_categories (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete cascade,
  code             text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name             text not null,
  requires_receipt boolean not null default true,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, code)
);

create trigger expense_categories_set_updated_at
  before update on public.expense_categories
  for each row execute function public.set_updated_at();

create table public.expense_reports (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  submitted_by          uuid not null references public.profiles(id),
  policy_id             uuid,
  organization_unit_id  uuid,
  title                 text not null check (char_length(btrim(title)) between 2 and 160),
  purpose               text,
  currency_code         text not null default 'CLP' check (currency_code ~ '^[A-Z]{3}$'),
  status                public.expense_report_status not null default 'DRAFT',
  total_amount          numeric(16,2) not null default 0 check (total_amount >= 0),
  submitted_at          timestamptz,
  resolved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, policy_id)
    references public.expense_policies(company_id, id),
  foreign key (company_id, organization_unit_id)
    references public.organization_units(company_id, id),
  constraint expense_reports_status_dates_chk check (
    (status = 'DRAFT' and submitted_at is null and resolved_at is null)
    or (status in ('SUBMITTED', 'IN_REVIEW') and submitted_at is not null and resolved_at is null)
    or (status in ('APPROVED', 'REJECTED', 'PAID', 'CANCELLED') and submitted_at is not null)
  )
);

create index expense_reports_company_status_idx
  on public.expense_reports(company_id, status, created_at desc);
create index expense_reports_submitter_idx
  on public.expense_reports(company_id, submitted_by, created_at desc);

create trigger expense_reports_set_updated_at
  before update on public.expense_reports
  for each row execute function public.set_updated_at();

create table public.expense_items (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references public.companies(id) on delete cascade,
  report_id             uuid not null,
  category_id           uuid,
  expense_date          date not null,
  merchant_name         text,
  description           text not null check (char_length(btrim(description)) between 2 and 240),
  net_amount            numeric(16,2) not null default 0 check (net_amount >= 0),
  tax_amount            numeric(16,2) not null default 0 check (tax_amount >= 0),
  total_amount          numeric(16,2) generated always as (net_amount + tax_amount) stored,
  currency_code         text not null default 'CLP' check (currency_code ~ '^[A-Z]{3}$'),
  receipt_status        public.expense_receipt_status not null default 'NOT_PROVIDED',
  receipt_storage_path  text,
  extraction            jsonb not null default '{}'::jsonb check (jsonb_typeof(extraction) = 'object'),
  duplicate_fingerprint text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, id),
  foreign key (company_id, report_id)
    references public.expense_reports(company_id, id) on delete cascade,
  foreign key (company_id, category_id)
    references public.expense_categories(company_id, id),
  constraint expense_items_receipt_path_chk check (
    receipt_status = 'NOT_PROVIDED' or receipt_storage_path is not null
  )
);

create index expense_items_report_idx on public.expense_items(company_id, report_id);
create index expense_items_duplicate_idx
  on public.expense_items(company_id, duplicate_fingerprint)
  where duplicate_fingerprint is not null;

create trigger expense_items_set_updated_at
  before update on public.expense_items
  for each row execute function public.set_updated_at();

create table public.expense_approval_decisions (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  report_id     uuid not null,
  step_number   integer not null check (step_number > 0),
  decided_by    uuid not null references public.profiles(id),
  decision      public.expense_approval_decision not null,
  comment       text,
  decided_at    timestamptz not null default now(),
  unique (company_id, report_id, step_number),
  foreign key (company_id, report_id)
    references public.expense_reports(company_id, id) on delete cascade
);

create table public.expense_audit_events (
  id          bigint generated always as identity primary key,
  company_id  uuid not null references public.companies(id) on delete cascade,
  report_id   uuid,
  actor_id    uuid references public.profiles(id),
  event_type  text not null,
  metadata    jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default now(),
  foreign key (company_id, report_id)
    references public.expense_reports(company_id, id) on delete cascade
);

create index expense_audit_company_idx
  on public.expense_audit_events(company_id, occurred_at desc);

-- El total del informe siempre se deriva de sus ítems; nunca se confía en un
-- total enviado por el navegador o por una integración.
create or replace function public.recalculate_expense_report_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_company_id uuid := coalesce(new.company_id, old.company_id);
  v_report_id uuid := coalesce(new.report_id, old.report_id);
begin
  update public.expense_reports er
  set total_amount = coalesce((
    select sum(ei.total_amount)
    from public.expense_items ei
    where ei.company_id = v_company_id and ei.report_id = v_report_id
  ), 0)
  where er.company_id = v_company_id and er.id = v_report_id;
  return coalesce(new, old);
end;
$$;

revoke all on function public.recalculate_expense_report_total() from public, anon, authenticated;

create trigger expense_items_recalculate_total
  after insert or update or delete on public.expense_items
  for each row execute function public.recalculate_expense_report_total();

create or replace function public.record_expense_report_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.expense_audit_events (company_id, report_id, actor_id, event_type, metadata)
    values (new.company_id, new.id, auth.uid(), 'expense_report.created',
      jsonb_build_object('status', new.status));
  elsif old.status is distinct from new.status then
    insert into public.expense_audit_events (company_id, report_id, actor_id, event_type, metadata)
    values (new.company_id, new.id, auth.uid(), 'expense_report.status_changed',
      jsonb_build_object('previous_status', old.status, 'status', new.status));
  elsif old.total_amount is distinct from new.total_amount then
    insert into public.expense_audit_events (company_id, report_id, actor_id, event_type, metadata)
    values (new.company_id, new.id, auth.uid(), 'expense_report.total_changed',
      jsonb_build_object('previous_total', old.total_amount, 'total', new.total_amount));
  end if;
  return new;
end;
$$;

revoke all on function public.record_expense_report_event() from public, anon, authenticated;

create trigger expense_reports_record_event
  after insert or update on public.expense_reports
  for each row execute function public.record_expense_report_event();

alter table public.expense_policies enable row level security;
alter table public.expense_categories enable row level security;
alter table public.expense_reports enable row level security;
alter table public.expense_items enable row level security;
alter table public.expense_approval_decisions enable row level security;
alter table public.expense_audit_events enable row level security;

create policy expense_policies_read on public.expense_policies for select to authenticated
  using (public.company_has_module(company_id, 'expenses') and public.is_active_company_member(company_id));
create policy expense_policies_create on public.expense_policies for insert to authenticated
  with check (public.company_has_module(company_id, 'expenses') and (public.has_company_permission(company_id, 'expenses.configure') or public.has_company_permission(company_id, 'expenses.manage')) and created_by = auth.uid());
create policy expense_policies_update on public.expense_policies for update to authenticated
  using (public.company_has_module(company_id, 'expenses') and (public.has_company_permission(company_id, 'expenses.configure') or public.has_company_permission(company_id, 'expenses.manage')))
  with check (public.company_has_module(company_id, 'expenses') and (public.has_company_permission(company_id, 'expenses.configure') or public.has_company_permission(company_id, 'expenses.manage')));

create policy expense_categories_read on public.expense_categories for select to authenticated
  using (public.company_has_module(company_id, 'expenses') and public.is_active_company_member(company_id));
create policy expense_categories_write on public.expense_categories for all to authenticated
  using (public.company_has_module(company_id, 'expenses') and (public.has_company_permission(company_id, 'expenses.configure') or public.has_company_permission(company_id, 'expenses.manage')))
  with check (public.company_has_module(company_id, 'expenses') and (public.has_company_permission(company_id, 'expenses.configure') or public.has_company_permission(company_id, 'expenses.manage')));

create policy expense_reports_read on public.expense_reports for select to authenticated
  using (
    public.company_has_module(company_id, 'expenses')
    and public.is_active_company_member(company_id)
    and (
      submitted_by = auth.uid()
      or public.has_company_permission(company_id, 'expenses.read')
      or public.has_company_permission(company_id, 'expenses.approve')
      or public.has_company_permission(company_id, 'expenses.manage')
    )
  );
create policy expense_reports_create on public.expense_reports for insert to authenticated
  with check (
    public.company_has_module(company_id, 'expenses')
    and public.is_active_company_member(company_id)
    and (public.has_company_permission(company_id, 'expenses.submit') or public.has_company_permission(company_id, 'expenses.manage'))
    and submitted_by = auth.uid()
    and status = 'DRAFT'
    and total_amount = 0
  );
create policy expense_reports_update_draft on public.expense_reports for update to authenticated
  using (
    status = 'DRAFT'
    and public.company_has_module(company_id, 'expenses')
    and (submitted_by = auth.uid() or public.has_company_permission(company_id, 'expenses.manage'))
  )
  with check (
    status = 'DRAFT'
    and public.company_has_module(company_id, 'expenses')
    and (submitted_by = auth.uid() or public.has_company_permission(company_id, 'expenses.manage'))
  );

create policy expense_items_read on public.expense_items for select to authenticated
  using (exists (
    select 1 from public.expense_reports er
    where er.company_id = expense_items.company_id and er.id = expense_items.report_id
  ));
create policy expense_items_create on public.expense_items for insert to authenticated
  with check (exists (
    select 1 from public.expense_reports er
    where er.company_id = expense_items.company_id and er.id = expense_items.report_id
      and er.status = 'DRAFT'
      and (er.submitted_by = auth.uid() or public.has_company_permission(er.company_id, 'expenses.manage'))
  ));
create policy expense_items_update on public.expense_items for update to authenticated
  using (exists (
    select 1 from public.expense_reports er
    where er.company_id = expense_items.company_id and er.id = expense_items.report_id
      and er.status = 'DRAFT'
      and (er.submitted_by = auth.uid() or public.has_company_permission(er.company_id, 'expenses.manage'))
  ))
  with check (exists (
    select 1 from public.expense_reports er
    where er.company_id = expense_items.company_id and er.id = expense_items.report_id
      and er.status = 'DRAFT'
      and (er.submitted_by = auth.uid() or public.has_company_permission(er.company_id, 'expenses.manage'))
  ));
create policy expense_items_delete on public.expense_items for delete to authenticated
  using (exists (
    select 1 from public.expense_reports er
    where er.company_id = expense_items.company_id and er.id = expense_items.report_id
      and er.status = 'DRAFT'
      and (er.submitted_by = auth.uid() or public.has_company_permission(er.company_id, 'expenses.manage'))
  ));

create policy expense_approvals_read on public.expense_approval_decisions for select to authenticated
  using (exists (
    select 1 from public.expense_reports er
    where er.company_id = expense_approval_decisions.company_id and er.id = expense_approval_decisions.report_id
  ));
create policy expense_approvals_create on public.expense_approval_decisions for insert to authenticated
  with check (
    public.company_has_module(company_id, 'expenses')
    and decided_by = auth.uid()
    and (public.has_company_permission(company_id, 'expenses.approve') or public.has_company_permission(company_id, 'expenses.manage'))
  );

create policy expense_audit_read on public.expense_audit_events for select to authenticated
  using (
    public.company_has_module(company_id, 'expenses')
    and (public.has_company_permission(company_id, 'audit.read') or public.has_company_permission(company_id, 'expenses.manage'))
  );

grant select, insert on public.expense_policies to authenticated;
grant update (name, version, currency_code, rules, active) on public.expense_policies to authenticated;
grant select, insert on public.expense_categories to authenticated;
grant update (code, name, requires_receipt, active) on public.expense_categories to authenticated;
grant select, insert on public.expense_reports to authenticated;
grant update (policy_id, organization_unit_id, title, purpose, currency_code) on public.expense_reports to authenticated;
grant select, insert, delete on public.expense_items to authenticated;
grant update (
  category_id, expense_date, merchant_name, description, net_amount, tax_amount,
  currency_code, receipt_status, receipt_storage_path, extraction, duplicate_fingerprint
) on public.expense_items to authenticated;
grant select, insert on public.expense_approval_decisions to authenticated;
grant select on public.expense_audit_events to authenticated;
revoke all on public.expense_policies, public.expense_categories, public.expense_reports,
  public.expense_items, public.expense_approval_decisions, public.expense_audit_events from anon;
revoke all on public.expense_audit_events from authenticated;
grant select on public.expense_audit_events to authenticated;

-- Reafirma privilegios explícitos también en Supabase Cloud, donde
-- service_role recibe defaults amplios. Las escrituras asíncronas futuras
-- deberán pasar por APIs/RPCs acotados en vez de obtener DELETE global.
revoke all on public.expense_policies, public.expense_categories, public.expense_reports,
  public.expense_items, public.expense_approval_decisions, public.expense_audit_events from service_role;
grant select, insert, update on public.expense_policies, public.expense_categories,
  public.expense_reports, public.expense_items to service_role;
grant delete on public.expense_items to service_role;
grant select, insert on public.expense_approval_decisions to service_role;
grant select on public.expense_audit_events to service_role;

-- Rendiciones ya posee su gate backend y RLS propios, por lo que puede
-- contratarse en ARCOTEX sin abrir la edición de módulos laborales legacy.
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

  insert into public.platform_audit_log (actor_id, company_id, action, target_type, target_id, metadata)
  values (v_actor_id, p_company_id, 'company.module.status_changed', 'company_module', p_module_key,
    jsonb_build_object('previous_status', v_previous_status, 'status', p_status));
end;
$$;

comment on table public.expense_reports is
  'Cabecera tenant-aware de Rendiciones. Puede operar aunque workspace_enabled sea false; company_modules es su entitlement.';
comment on table public.expense_items is
  'Gastos individuales aislados por empresa; total_amount se deriva en base de datos.';
comment on table public.expense_audit_events is
  'Bitácora append-only del dominio Rendiciones; los clientes solo reciben lectura autorizada.';
