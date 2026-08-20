-- =============================================================================
-- Nómina de Pago -- gestión de reemplazo seguro del maestro de proveedores.
-- =============================================================================
--
-- Encargo real: reemplazar el archivo/maestro de proveedores de forma segura
-- (validar -> vista previa -> confirmar -> persistir archivo -> persistir
-- cambios -> activar el nuevo -> marcar el anterior como reemplazado), con
-- historial auditable completo. Reutiliza `public.suppliers` (ya existente,
-- Fase Nómina de Pago) -- esta migración SOLO agrega lo que faltaba: un
-- identificador canónico verdaderamente estable (RUT normalizado, nunca
-- nombre) y la tabla de auditoría de importaciones del archivo maestro.
--
-- Dominio: exclusivamente Nómina de Pago / maestro de proveedores. No toca
-- ninguna tabla de Workera/asistencia/sync.

-- -----------------------------------------------------------------------------
-- 1) Identificador canónico real: RUT normalizado (nunca nombre -- dos
--    proveedores pueden tener nombres parecidos, nunca el mismo RUT). El
--    cruce contra el Excel mensual de facturas (`invoice-import.ts`, ya
--    existente) sigue siendo por nombre porque ese archivo de finanzas NO
--    trae RUT -- eso no cambia acá. `normalized_rut` es SOLO para saber si
--    una fila del maestro subido es un proveedor nuevo/existente.

alter table public.suppliers
  add column normalized_rut text;

update public.suppliers
  set normalized_rut = upper(regexp_replace(rut, '[^0-9kK]', '', 'g'));

alter table public.suppliers
  alter column normalized_rut set not null;

-- Único entre proveedores ACTIVOS (mismo patrón "is_current"/partial-unique ya
-- usado en el resto del esquema) -- permite conservar un duplicado histórico
-- desactivado (nunca borrado) en vez de forzar un unique constraint global
-- que rompería con datos reales ya importados que resultaron ser el mismo
-- proveedor tipeado dos veces (verificado real: mismo RUT, nombre con
-- puntuación distinta -- "INSTITUTO DE DIAGNOSTICO S.A" vs "...SA").
create unique index suppliers_normalized_rut_active_idx
  on public.suppliers (normalized_rut)
  where active;

create index suppliers_normalized_rut_idx on public.suppliers (normalized_rut);

comment on column public.suppliers.normalized_rut is
  'RUT sin puntos/guiones/espacios, mayúsculas -- identificador canónico real '
  'del proveedor para el reemplazo del maestro (PASO 7 del encargo: nunca '
  'fuzzy-match por nombre). Único solo entre proveedores activos -- un '
  'duplicado detectado se desactiva, nunca se borra. El cruce con el Excel '
  'mensual de facturas sigue usando normalized_name porque ese archivo no '
  'trae RUT.';

-- -----------------------------------------------------------------------------
-- 2) Auditoría de reemplazos del archivo maestro. Exactamente UNA fila puede
--    estar ACTIVE a la vez (índice único parcial, mismo patrón que
--    `is_current` en el resto del esquema) -- Nómina de Pago siempre lee del
--    maestro ACTIVE únicamente.

create type public.supplier_master_import_status as enum (
  'VALIDATING',
  'READY',
  'IMPORTING',
  'ACTIVE',
  'REPLACED',
  'FAILED'
);

create table public.supplier_master_imports (
  id                  uuid primary key default gen_random_uuid(),

  uploaded_by         uuid not null references public.profiles(id),
  uploaded_at         timestamptz not null default now(),

  original_filename   text not null,
  storage_path        text, -- null mientras status='VALIDATING' (todavía no se subió nada a Storage)
  file_size           integer not null check (file_size >= 0),

  row_count           integer not null check (row_count >= 0),
  inserted_count      integer not null default 0 check (inserted_count >= 0),
  updated_count       integer not null default 0 check (updated_count >= 0),
  unchanged_count     integer not null default 0 check (unchanged_count >= 0),
  rejected_count      integer not null default 0 check (rejected_count >= 0),

  status              public.supplier_master_import_status not null default 'VALIDATING',
  replaces_import_id  uuid references public.supplier_master_imports(id),

  activated_at        timestamptz,
  replaced_at         timestamptz,

  created_at          timestamptz not null default now(),

  constraint supplier_master_imports_activated_chk
    check ((status in ('ACTIVE', 'REPLACED')) = (activated_at is not null)),
  constraint supplier_master_imports_replaced_chk
    check ((status = 'REPLACED') = (replaced_at is not null))
);

comment on table public.supplier_master_imports is
  'Historial auditable de cada reemplazo del maestro de proveedores. Exactamente '
  'una fila ACTIVE a la vez (índice único parcial abajo) -- Nómina de Pago '
  'siempre lee de esa fila. Nunca se borra una fila (auditoría permanente); '
  'un reemplazo exitoso pasa la fila anterior a REPLACED, nunca la elimina.';

create unique index supplier_master_imports_single_active_idx
  on public.supplier_master_imports (status)
  where status = 'ACTIVE';

create index supplier_master_imports_uploaded_at_idx on public.supplier_master_imports (uploaded_at desc);

alter table public.supplier_master_imports enable row level security;

create policy supplier_master_imports_select on public.supplier_master_imports
  for select to authenticated using (public.is_privileged_admin());
create policy supplier_master_imports_insert on public.supplier_master_imports
  for insert to authenticated
  with check (public.is_privileged_admin() and uploaded_by = auth.uid());
create policy supplier_master_imports_update on public.supplier_master_imports
  for update to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin());

grant select, insert, update on table public.supplier_master_imports to authenticated;
grant select, insert, update on table public.supplier_master_imports to service_role;

-- -----------------------------------------------------------------------------
-- 2b) Persistencia + activación atómica -- TODO en una sola función (una
--    transacción implícita), no una secuencia de llamadas desde la app.
--    Motivo real (encontrado al verificar con datos reales): si el registro
--    del import + la escritura de `suppliers` + la activación son pasos
--    separados, una falla ENTRE escribir `suppliers` y activar deja los
--    datos de proveedores ya mutados con el archivo nuevo, mientras el
--    import "activo" registrado en la auditoría sigue siendo el viejo --
--    una violación real de "si falla, el maestro anterior permanece sin
--    cambios parciales". Con todo en una función, cualquier error (por
--    ejemplo una violación de constraint) revierte la transacción completa:
--    ni el import nuevo, ni los cambios de `suppliers`, ni el estado ACTIVE
--    del anterior quedan a medias. SECURITY INVOKER (default) -- las
--    políticas RLS (is_privileged_admin()) sobre `suppliers` y
--    `supplier_master_imports` se siguen aplicando con el rol de quien
--    llama, igual que el resto del esquema; una violación de RLS revierte
--    toda la función igual que cualquier otro error.

create function public.apply_supplier_master_import(
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
  insert into public.supplier_master_imports (
    id, uploaded_by, original_filename, storage_path, file_size, row_count,
    inserted_count, updated_count, unchanged_count, rejected_count, status
  ) values (
    p_import_id, p_uploaded_by, p_original_filename, p_storage_path, p_file_size, p_row_count,
    p_inserted_count, p_updated_count, p_unchanged_count, p_rejected_count, 'IMPORTING'
  );

  insert into public.suppliers (rut, name, normalized_name, normalized_rut, payment_method, bank_code, account_number, active, created_by)
  select
    r->>'rut', r->>'name', r->>'normalized_name', r->>'normalized_rut',
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
  where s.id = (r->>'id')::uuid;

  update public.supplier_master_imports
    set status = 'REPLACED', replaced_at = now()
    where status = 'ACTIVE' and id <> p_import_id;

  update public.supplier_master_imports
    set status = 'ACTIVE', activated_at = now()
    where id = p_import_id;
end;
$$;

grant execute on function public.apply_supplier_master_import(uuid, uuid, text, text, integer, integer, integer, integer, integer, integer, jsonb, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- 3) Bucket privado para el archivo físico del maestro -- mismo patrón exacto
--    que `supporting-documents` (Fase 8, documentos de licencia/médicos):
--    INSERT y SELECT/descarga solo `is_privileged_admin()` (acá no hay
--    equivalente a "el supervisor adjunta pero no descarga" -- el maestro de
--    proveedores es información financiera, ambas operaciones son
--    privilegiadas). Nunca público, nunca URLs permanentes -- solo signed
--    URLs de corta duración generadas en el momento de la descarga.

insert into storage.buckets (id, name, public)
values ('supplier-master-files', 'supplier-master-files', false)
on conflict (id) do nothing;

create policy "supplier_master_files_storage_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'supplier-master-files'
    and public.is_privileged_admin()
  );

create policy "supplier_master_files_storage_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'supplier-master-files'
    and public.is_privileged_admin()
  );
