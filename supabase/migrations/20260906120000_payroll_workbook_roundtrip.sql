-- Marcha blanca de pre-nómina: archivo exacto, diferencias normalizadas,
-- conflictos e historial. No activa cierres ni toca datos productivos.

create type public.payroll_workbook_version_status as enum
  ('UPLOADED', 'ACCEPTED', 'INVALIDATED', 'CLOSED_SNAPSHOT');

create table public.payroll_workbook_versions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  reporting_period_id uuid not null references public.reporting_periods(id),
  period_start date not null,
  period_end date not null,
  version_number integer not null check (version_number > 0),
  base_version_id uuid references public.payroll_workbook_versions(id),
  status public.payroll_workbook_version_status not null default 'UPLOADED',
  schema_version text not null check (schema_version = 'GESTORA_PRENOMINA_2026_V2'),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  file_size integer not null check (file_size between 1 and 15728640),
  storage_path text not null unique,
  general_reason text not null check (length(trim(general_reason)) > 0),
  uploaded_by uuid not null references public.profiles(id),
  uploaded_at timestamptz not null default clock_timestamp(),
  accepted_by uuid references public.profiles(id),
  accepted_at timestamptz,
  invalidated_by uuid references public.profiles(id),
  invalidated_at timestamptz,
  closed_snapshot_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, reporting_period_id, version_number),
  unique (company_id, reporting_period_id, content_sha256),
  check (period_end >= period_start),
  check ((status = 'ACCEPTED') = (accepted_by is not null and accepted_at is not null)
    or status in ('UPLOADED', 'INVALIDATED', 'CLOSED_SNAPSHOT')),
  check ((status = 'CLOSED_SNAPSHOT') = (closed_snapshot_at is not null)
    or status <> 'CLOSED_SNAPSHOT')
);

create table public.payroll_workbook_changes (
  id uuid primary key default gen_random_uuid(),
  workbook_version_id uuid not null references public.payroll_workbook_versions(id),
  sheet_name text not null,
  cell_reference text not null,
  stable_key text,
  employee_id uuid references public.employees(id),
  work_date date,
  field_code text,
  change_kind text not null check (change_kind in ('VALUE','FORMULA','FORMAT','STRUCTURE')),
  previous_value jsonb,
  new_value jsonb,
  consequence text not null check (consequence in ('AJUSTE_EMPRESARIAL','CONSERVAR_ARCHIVO_SIN_EJECUTAR')),
  reason text not null check (length(trim(reason)) > 0),
  decided_by uuid not null references public.profiles(id),
  decided_at timestamptz not null default clock_timestamp(),
  unique (workbook_version_id, sheet_name, cell_reference, change_kind)
);

create table public.payroll_workbook_conflicts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  reporting_period_id uuid not null references public.reporting_periods(id),
  stable_key text not null,
  workera_value jsonb,
  rrhh_value jsonb not null,
  resolved_value jsonb,
  resolution text check (resolution in ('KEEP_RRHH','ACCEPT_WORKERA','THIRD_VALUE')),
  resolved_by uuid references public.profiles(id),
  resolved_at timestamptz,
  reason text,
  created_at timestamptz not null default clock_timestamp(),
  unique (company_id, reporting_period_id, stable_key, resolved_at)
);

create index payroll_workbook_versions_period_idx on public.payroll_workbook_versions(company_id, reporting_period_id, version_number desc);
create index payroll_workbook_changes_stable_idx on public.payroll_workbook_changes(stable_key, decided_at desc);
create index payroll_workbook_conflicts_open_idx on public.payroll_workbook_conflicts(company_id, reporting_period_id) where resolved_at is null;

alter table public.payroll_workbook_versions enable row level security;
alter table public.payroll_workbook_changes enable row level security;
alter table public.payroll_workbook_conflicts enable row level security;

create policy payroll_workbook_versions_read on public.payroll_workbook_versions for select to authenticated
using (public.is_active_company_member(company_id) and public.current_user_role() in ('ADMIN_RRHH','SUPER_ADMIN'));
create policy payroll_workbook_changes_read on public.payroll_workbook_changes for select to authenticated
using (exists (select 1 from public.payroll_workbook_versions v where v.id = workbook_version_id and public.is_active_company_member(v.company_id)) and public.current_user_role() in ('ADMIN_RRHH','SUPER_ADMIN'));
create policy payroll_workbook_conflicts_read on public.payroll_workbook_conflicts for select to authenticated
using (public.is_active_company_member(company_id) and public.current_user_role() in ('ADMIN_RRHH','SUPER_ADMIN'));

-- Toda mutación empresarial entra por RPC; SUPER_ADMIN conserva auditoría y
-- descarga, pero no puede aparecer como decisión de RR. HH.
revoke all on public.payroll_workbook_versions, public.payroll_workbook_changes, public.payroll_workbook_conflicts from anon, authenticated;
grant select on public.payroll_workbook_versions, public.payroll_workbook_changes, public.payroll_workbook_conflicts to authenticated;

create or replace function public.accept_payroll_workbook_version(p_version_id uuid, p_expected_base_version_id uuid)
returns public.payroll_workbook_versions
language plpgsql volatile security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_version public.payroll_workbook_versions%rowtype; v_latest uuid;
begin
  if v_actor is null or public.current_user_role() <> 'ADMIN_RRHH' then raise exception 'Solo RR. HH. puede confirmar una pre-nómina.' using errcode='42501'; end if;
  perform public.enforce_mfa_for_privileged();
  select * into v_version from public.payroll_workbook_versions where id=p_version_id for update;
  if not found or not public.is_active_company_member(v_version.company_id) then raise exception 'Versión no disponible.' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('payroll-workbook|'||v_version.company_id::text||'|'||v_version.reporting_period_id::text,0));
  select id into v_latest from public.payroll_workbook_versions where company_id=v_version.company_id and reporting_period_id=v_version.reporting_period_id and status='ACCEPTED' order by version_number desc limit 1;
  if v_latest is distinct from p_expected_base_version_id then raise exception 'La pre-nómina cambió mientras la revisabas. Vuelve a comparar.' using errcode='40001'; end if;
  if v_version.status <> 'UPLOADED' then raise exception 'La versión ya fue procesada.' using errcode='23505'; end if;
  update public.payroll_workbook_versions set status='ACCEPTED', accepted_by=v_actor, accepted_at=clock_timestamp() where id=p_version_id returning * into v_version;
  return v_version;
end $$;

revoke all on function public.accept_payroll_workbook_version(uuid,uuid) from public, anon;
grant execute on function public.accept_payroll_workbook_version(uuid,uuid) to authenticated;

create or replace function public.register_accepted_payroll_workbook(
  p_company_id uuid, p_period_start date, p_period_end date,
  p_expected_base_version_id uuid, p_content_sha256 text, p_file_size integer,
  p_storage_path text, p_general_reason text, p_changes jsonb
) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid:=auth.uid(); v_period uuid; v_latest uuid; v_id uuid:=gen_random_uuid(); v_number integer;
begin
  if v_actor is null or public.current_user_role()<>'ADMIN_RRHH' or not public.is_active_company_member(p_company_id) then raise exception 'Solo RR. HH. puede confirmar una pre-nómina.' using errcode='42501'; end if;
  perform public.enforce_mfa_for_privileged();
  if p_period_end <> (date_trunc('month',p_period_end)::date + 14) or p_period_start <> ((date_trunc('month',p_period_end)::date - 1) - interval '15 days')::date then raise exception 'El período debe corresponder al corte 16-15.' using errcode='22023'; end if;
  if p_content_sha256 !~ '^[a-f0-9]{64}$' or p_file_size not between 1 and 15728640 or length(trim(coalesce(p_general_reason,'')))=0 then raise exception 'Metadatos de archivo inválidos.' using errcode='22023'; end if;
  -- reporting_periods sigue siendo parte del dominio laboral ARCOTEX legacy y
  -- aún no tiene company_id; la versión sí congela explícitamente la empresa.
  select id into v_period from public.reporting_periods where period_start=p_period_start and period_end=p_period_end;
  if v_period is null then raise exception 'El período no existe para esta empresa.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('payroll-workbook|'||p_company_id::text||'|'||v_period::text,0));
  select id into v_latest from public.payroll_workbook_versions where company_id=p_company_id and reporting_period_id=v_period and status='ACCEPTED' order by version_number desc limit 1;
  if v_latest is distinct from p_expected_base_version_id then raise exception 'La pre-nómina cambió mientras la revisabas. Vuelve a comparar.' using errcode='40001'; end if;
  if exists(select 1 from public.payroll_workbook_versions where company_id=p_company_id and reporting_period_id=v_period and content_sha256=p_content_sha256) then return (select id from public.payroll_workbook_versions where company_id=p_company_id and reporting_period_id=v_period and content_sha256=p_content_sha256); end if;
  select coalesce(max(version_number),0)+1 into v_number from public.payroll_workbook_versions where company_id=p_company_id and reporting_period_id=v_period;
  insert into public.payroll_workbook_versions(id,company_id,reporting_period_id,period_start,period_end,version_number,base_version_id,status,schema_version,content_sha256,file_size,storage_path,general_reason,uploaded_by,accepted_by,accepted_at)
  values(v_id,p_company_id,v_period,p_period_start,p_period_end,v_number,v_latest,'ACCEPTED','GESTORA_PRENOMINA_2026_V2',p_content_sha256,p_file_size,p_storage_path,trim(p_general_reason),v_actor,v_actor,clock_timestamp());
  insert into public.payroll_workbook_changes(workbook_version_id,sheet_name,cell_reference,stable_key,change_kind,previous_value,new_value,consequence,reason,decided_by)
  select v_id, x->>'sheet',x->>'cell',x->>'stableKey',x->>'kind',x->'previous',x->'next',x->>'consequence',trim(p_general_reason),v_actor from jsonb_array_elements(coalesce(p_changes,'[]'::jsonb)) x;
  return v_id;
end $$;
revoke all on function public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb) from public,anon;
grant execute on function public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('payroll-workbooks','payroll-workbooks',false,15728640,array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create policy payroll_workbooks_storage_insert on storage.objects for insert to authenticated with check (
  bucket_id='payroll-workbooks' and public.current_user_role()='ADMIN_RRHH'
  and split_part(name,'/',1) ~ '^[0-9a-f-]{36}$'
  and public.is_active_company_member(split_part(name,'/',1)::uuid)
);
create policy payroll_workbooks_storage_read on storage.objects for select to authenticated using (
  bucket_id='payroll-workbooks' and public.current_user_role() in ('ADMIN_RRHH','SUPER_ADMIN')
  and split_part(name,'/',1) ~ '^[0-9a-f-]{36}$'
  and public.is_active_company_member(split_part(name,'/',1)::uuid)
);

comment on table public.payroll_workbook_versions is 'Versiones privadas e inmutables del archivo exacto de pre-nómina subido o cerrado.';
comment on table public.payroll_workbook_changes is 'Cambios aceptados por clave estable. Fórmulas/formato se conservan sin ejecutarse como dato contable.';
