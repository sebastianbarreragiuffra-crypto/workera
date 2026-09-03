-- GESTORA MT-3B — aislamiento tenant del vertical Nómina de Pago.
--
-- Rebanada deliberadamente separada de asistencia/Workera para no solaparse
-- con MB-6/MB-7. ARCOTEX sigue siendo el único workspace habilitado.

-- 1) Propagar company_id sin conservar un default implícito.
alter table public.suppliers add column company_id uuid;
alter table public.payroll_batches add column company_id uuid;
alter table public.payroll_batch_items add column company_id uuid;
alter table public.supplier_master_imports add column company_id uuid;

update public.suppliers
set company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
where company_id is null;

update public.payroll_batches
set company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
where company_id is null;

update public.payroll_batch_items i
set company_id = b.company_id
from public.payroll_batches b
where b.id = i.batch_id and i.company_id is null;

update public.supplier_master_imports
set company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
where company_id is null;

alter table public.suppliers alter column company_id set not null;
alter table public.payroll_batches alter column company_id set not null;
alter table public.payroll_batch_items alter column company_id set not null;
alter table public.supplier_master_imports alter column company_id set not null;

-- El gate temporal de MT-3A también cubre este vertical, incluso para jobs
-- con service_role (que pueden omitir RLS).
create trigger suppliers_require_enabled_workspace
  before insert or update of company_id on public.suppliers
  for each row execute function public.enforce_operational_company_workspace_enabled();
create trigger payroll_batches_require_enabled_workspace
  before insert or update of company_id on public.payroll_batches
  for each row execute function public.enforce_operational_company_workspace_enabled();
create trigger payroll_batch_items_require_enabled_workspace
  before insert or update of company_id on public.payroll_batch_items
  for each row execute function public.enforce_operational_company_workspace_enabled();
create trigger supplier_master_imports_require_enabled_workspace
  before insert or update of company_id on public.supplier_master_imports
  for each row execute function public.enforce_operational_company_workspace_enabled();

alter table public.suppliers
  add constraint suppliers_company_id_fkey foreign key (company_id) references public.companies(id),
  add constraint suppliers_company_id_id_key unique (company_id, id);

alter table public.payroll_batches
  add constraint payroll_batches_company_id_fkey foreign key (company_id) references public.companies(id),
  add constraint payroll_batches_company_id_id_key unique (company_id, id);

alter table public.supplier_master_imports
  add constraint supplier_master_imports_company_id_fkey foreign key (company_id) references public.companies(id),
  add constraint supplier_master_imports_company_id_id_key unique (company_id, id);

-- 2) Las identidades de proveedor y el maestro activo son únicas por empresa.
alter table public.suppliers drop constraint suppliers_normalized_name_key;
drop index public.suppliers_normalized_rut_active_idx;
create unique index suppliers_company_normalized_name_key
  on public.suppliers (company_id, normalized_name);
create unique index suppliers_company_normalized_rut_active_idx
  on public.suppliers (company_id, normalized_rut)
  where active;

drop index public.supplier_master_imports_single_active_idx;
create unique index supplier_master_imports_company_single_active_idx
  on public.supplier_master_imports (company_id)
  where status = 'ACTIVE';

-- 3) Toda relación del vertical lleva company_id en la FK.
alter table public.payroll_batch_items
  drop constraint payroll_batch_items_batch_id_fkey,
  drop constraint payroll_batch_items_supplier_id_fkey,
  add constraint payroll_batch_items_company_id_fkey
    foreign key (company_id) references public.companies(id),
  add constraint payroll_batch_items_company_batch_fkey
    foreign key (company_id, batch_id)
    references public.payroll_batches(company_id, id),
  add constraint payroll_batch_items_company_supplier_fkey
    foreign key (company_id, supplier_id)
    references public.suppliers(company_id, id);

alter table public.supplier_master_imports
  drop constraint supplier_master_imports_replaces_import_id_fkey,
  add constraint supplier_master_imports_company_replaces_fkey
    foreign key (company_id, replaces_import_id)
    references public.supplier_master_imports(company_id, id);

create index suppliers_company_active_idx
  on public.suppliers (company_id, active);
create index payroll_batches_company_generated_at_idx
  on public.payroll_batches (company_id, generated_at desc);
drop index public.payroll_batch_items_batch_id_idx;
create index payroll_batch_items_company_batch_idx
  on public.payroll_batch_items (company_id, batch_id);
drop index public.supplier_master_imports_uploaded_at_idx;
create index supplier_master_imports_company_uploaded_at_idx
  on public.supplier_master_imports (company_id, uploaded_at desc);

-- 4) Reemplazar policies legacy globales. Permiso y módulo se verifican en DB.
drop policy suppliers_select on public.suppliers;
drop policy suppliers_write_admin on public.suppliers;
drop policy payroll_batches_select on public.payroll_batches;
drop policy payroll_batches_insert on public.payroll_batches;
drop policy payroll_batch_items_select on public.payroll_batch_items;
drop policy payroll_batch_items_insert on public.payroll_batch_items;
drop policy supplier_master_imports_select on public.supplier_master_imports;
drop policy supplier_master_imports_insert on public.supplier_master_imports;
drop policy supplier_master_imports_update on public.supplier_master_imports;

create policy suppliers_select_tenant on public.suppliers
  for select to authenticated
  using (
    public.is_active_company_member(company_id)
    and
    public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.read')
  );
create policy suppliers_write_tenant on public.suppliers
  for all to authenticated
  using (
    public.is_active_company_member(company_id)
    and
    public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.manage')
  )
  with check (
    public.is_active_company_member(company_id)
    and
    public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.manage')
  );

create policy payroll_batches_select_tenant on public.payroll_batches
  for select to authenticated
  using (
    public.is_active_company_member(company_id)
    and
    public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.read')
  );
create policy payroll_batches_insert_tenant on public.payroll_batches
  for insert to authenticated
  with check (
    generated_by = auth.uid()
    and public.is_active_company_member(company_id)
    and public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.manage')
  );

create policy payroll_batch_items_select_tenant on public.payroll_batch_items
  for select to authenticated
  using (
    public.is_active_company_member(company_id)
    and
    public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.read')
  );
create policy payroll_batch_items_insert_tenant on public.payroll_batch_items
  for insert to authenticated
  with check (
    public.is_active_company_member(company_id)
    and
    public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.manage')
    and exists (
      select 1 from public.payroll_batches b
      where b.company_id = payroll_batch_items.company_id
        and b.id = payroll_batch_items.batch_id
        and b.generated_by = auth.uid()
    )
  );

create policy supplier_master_imports_select_tenant on public.supplier_master_imports
  for select to authenticated
  using (
    public.is_active_company_member(company_id)
    and
    public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.read')
  );
create policy supplier_master_imports_insert_tenant on public.supplier_master_imports
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and public.is_active_company_member(company_id)
    and public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.manage')
  );
create policy supplier_master_imports_update_tenant on public.supplier_master_imports
  for update to authenticated
  using (
    public.is_active_company_member(company_id)
    and
    public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.manage')
  )
  with check (
    public.is_active_company_member(company_id)
    and
    public.company_has_module(company_id, 'payroll')
    and public.has_company_permission(company_id, 'payroll.manage')
  );

-- 5) RPC atómico: tenant explícito, validado y propagado a cada write.
drop function public.apply_supplier_master_import(
  uuid, uuid, text, text, integer, integer, integer, integer, integer, integer, jsonb, jsonb
);

create function public.apply_supplier_master_import(
  p_company_id uuid,
  p_import_id uuid,
  p_uploaded_by uuid,
  p_original_filename text,
  p_storage_path text,
  p_file_size integer,
  p_row_count integer,
  p_inserted_count integer,
  p_updated_count integer,
  p_unchanged_count integer,
  p_rejected_count integer,
  p_insert_rows jsonb,
  p_update_rows jsonb
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_uploaded_by <> auth.uid()
     or not public.is_active_company_member(p_company_id)
     or not public.company_has_module(p_company_id, 'payroll')
     or not public.has_company_permission(p_company_id, 'payroll.manage') then
    raise exception 'No autorizado para administrar la nómina de esta empresa.' using errcode = '42501';
  end if;

  if split_part(p_storage_path, '/', 1) <> p_company_id::text then
    raise exception 'La ruta de Storage no pertenece a la empresa.' using errcode = '23514';
  end if;

  insert into public.supplier_master_imports (
    company_id, id, uploaded_by, original_filename, storage_path, file_size,
    row_count, inserted_count, updated_count, unchanged_count, rejected_count, status
  ) values (
    p_company_id, p_import_id, p_uploaded_by, p_original_filename, p_storage_path, p_file_size,
    p_row_count, p_inserted_count, p_updated_count, p_unchanged_count, p_rejected_count, 'IMPORTING'
  );

  insert into public.suppliers (
    company_id, rut, name, normalized_name, normalized_rut, payment_method,
    bank_code, account_number, active, created_by
  )
  select
    p_company_id, r->>'rut', r->>'name', r->>'normalized_name', r->>'normalized_rut',
    r->>'payment_method', r->>'bank_code', r->>'account_number', true, p_uploaded_by
  from jsonb_array_elements(p_insert_rows) as r;

  update public.suppliers s set
    rut = r->>'rut',
    name = r->>'name',
    normalized_name = r->>'normalized_name',
    payment_method = r->>'payment_method',
    bank_code = r->>'bank_code',
    account_number = r->>'account_number'
  from jsonb_array_elements(p_update_rows) as r
  where s.company_id = p_company_id and s.id = (r->>'id')::uuid;

  update public.supplier_master_imports
  set status = 'REPLACED', replaced_at = now()
  where company_id = p_company_id and status = 'ACTIVE' and id <> p_import_id;

  update public.supplier_master_imports
  set status = 'ACTIVE', activated_at = now()
  where company_id = p_company_id and id = p_import_id;
end;
$$;

grant execute on function public.apply_supplier_master_import(
  uuid, uuid, uuid, text, text, integer, integer, integer, integer, integer, integer, jsonb, jsonb
) to authenticated;
revoke all on function public.apply_supplier_master_import(
  uuid, uuid, uuid, text, text, integer, integer, integer, integer, integer, integer, jsonb, jsonb
) from anon, public;

-- 6) Storage tenant-aware. Los objetos históricos se mueven al prefijo ARCOTEX.
update storage.objects
set name = '0a4c0000-0000-0000-0000-000000000001/' || name
where bucket_id = 'supplier-master-files'
  and name not like '0a4c0000-0000-0000-0000-000000000001/%';

update public.supplier_master_imports
set storage_path = company_id::text || '/' || storage_path
where storage_path is not null
  and storage_path not like company_id::text || '/%';

drop policy "supplier_master_files_storage_insert" on storage.objects;
drop policy "supplier_master_files_storage_select" on storage.objects;

create policy "supplier_master_files_storage_insert_tenant"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'supplier-master-files'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_active_company_member(((storage.foldername(name))[1])::uuid)
    and public.company_has_module(((storage.foldername(name))[1])::uuid, 'payroll')
    and public.has_company_permission(((storage.foldername(name))[1])::uuid, 'payroll.manage')
  );

create policy "supplier_master_files_storage_select_tenant"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'supplier-master-files'
    and (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.is_active_company_member(((storage.foldername(name))[1])::uuid)
    and public.company_has_module(((storage.foldername(name))[1])::uuid, 'payroll')
    and public.has_company_permission(((storage.foldername(name))[1])::uuid, 'payroll.read')
  );

comment on column public.suppliers.company_id is
  'Tenant propietario. MT-3B: obligatorio, sin default implícito y presente en claves de negocio.';
