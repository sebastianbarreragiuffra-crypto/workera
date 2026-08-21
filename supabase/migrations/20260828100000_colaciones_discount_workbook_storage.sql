-- =============================================================================
-- Colaciones -- fuente compartida para el Excel de descuentos de Producción.
-- =============================================================================
--
-- Encargo real: "DESCUENTO DE COLACIONES.xlsx" se leía del disco local en
-- cada request (`source-workbook.ts`, `process.cwd()`) -- el archivo está en
-- `.gitignore` (regla genérica `*.xlsx`), así que nunca viaja con el
-- despliegue. En Vercel, o en cualquier PC que no sea el que lo tiene a
-- mano, esa lectura SIEMPRE falla. Esta migración reemplaza esa dependencia
-- de filesystem por Supabase Storage (privado) + una tabla de metadata que
-- registra exactamente cuál versión está activa -- mismo patrón exacto ya
-- usado para el maestro de proveedores (`supplier_master_imports` /
-- `supplier-master-files`, ver 20260824100000), sin inventar uno nuevo.
--
-- Dominio: exclusivamente Colaciones / panel de descuento de Producción. No
-- toca Workera, Licencias, asistencia, Nómina ni Google Forms.

-- -----------------------------------------------------------------------------
-- 1) Metadata de versiones del archivo. Exactamente UNA fila puede estar
--    active=true a la vez (índice único parcial, mismo patrón "is_current"/
--    "ACTIVE" ya usado en el resto del esquema). Nunca se borra una fila --
--    auditoría permanente de reemplazos.

create table public.colaciones_discount_workbooks (
  id                  uuid primary key default gen_random_uuid(),

  storage_path        text not null,
  original_filename   text not null,
  file_size           integer not null check (file_size >= 0),
  checksum            text not null,

  uploaded_by         uuid not null references public.profiles(id),
  uploaded_at         timestamptz not null default now(),

  active              boolean not null default false,

  created_at          timestamptz not null default now()
);

comment on table public.colaciones_discount_workbooks is
  'Historial auditable de cada reemplazo del Excel de descuentos de '
  'Colaciones (Producción). Exactamente una fila active=true a la vez '
  '(índice único parcial abajo) -- Colaciones siempre lee de esa fila, '
  'nunca del filesystem. Nunca se borra una fila.';

create unique index colaciones_discount_workbooks_single_active_idx
  on public.colaciones_discount_workbooks (active)
  where active;

create index colaciones_discount_workbooks_uploaded_at_idx on public.colaciones_discount_workbooks (uploaded_at desc);

alter table public.colaciones_discount_workbooks enable row level security;

-- Mismo criterio que el maestro de proveedores: leer/reemplazar este archivo
-- es una operación privilegiada (SUPER_ADMIN/ADMIN_RRHH), igual que quién
-- puede ver el panel de Colaciones que lo consume (ver isPrivilegedAdmin()
-- en el gate de /colaciones -- ambos ya coinciden, no se amplía nada).
create policy colaciones_discount_workbooks_select on public.colaciones_discount_workbooks
  for select to authenticated using (public.is_privileged_admin());
create policy colaciones_discount_workbooks_insert on public.colaciones_discount_workbooks
  for insert to authenticated
  with check (public.is_privileged_admin() and uploaded_by = auth.uid());
create policy colaciones_discount_workbooks_update on public.colaciones_discount_workbooks
  for update to authenticated
  using (public.is_privileged_admin())
  with check (public.is_privileged_admin());

grant select, insert, update on table public.colaciones_discount_workbooks to authenticated;
grant select, insert, update on table public.colaciones_discount_workbooks to service_role;

-- -----------------------------------------------------------------------------
-- 2) Activación atómica -- TODO en una sola función (una transacción
--    implícita), mismo motivo ya documentado en `apply_supplier_master_import`:
--    si "insertar la fila nueva" y "desactivar la anterior" fueran pasos
--    separados desde la app, una falla entre medio dejaría dos archivos
--    activos o ninguno. La fila nueva se inserta con active=false y recién
--    se activa DESPUÉS de desactivar la anterior -- así el índice único
--    parcial (active=true) nunca ve dos filas activas al mismo tiempo, ni
--    siquiera transitoriamente dentro de la misma transacción.
--    SECURITY INVOKER (default): RLS de esta tabla se sigue aplicando con el
--    rol real de quien llama.

create function public.activate_colaciones_discount_workbook(
  p_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_file_size integer,
  p_checksum text,
  p_uploaded_by uuid
)
returns void
language plpgsql
set search_path = public
as $$
begin
  insert into public.colaciones_discount_workbooks (
    id, storage_path, original_filename, file_size, checksum, uploaded_by, active
  ) values (
    p_id, p_storage_path, p_original_filename, p_file_size, p_checksum, p_uploaded_by, false
  );

  update public.colaciones_discount_workbooks set active = false where active and id <> p_id;

  update public.colaciones_discount_workbooks set active = true where id = p_id;
end;
$$;

grant execute on function public.activate_colaciones_discount_workbook(uuid, text, text, integer, text, uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- 3) Bucket privado para el archivo físico -- mismo patrón exacto que
--    `supplier-master-files`: INSERT y SELECT/descarga solo
--    `is_privileged_admin()`. El workbook real puede contener información
--    operativa de sueldos/descuentos -- nunca público, nunca URL permanente.

insert into storage.buckets (id, name, public)
values ('colaciones-config-files', 'colaciones-config-files', false)
on conflict (id) do nothing;

create policy "colaciones_config_files_storage_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'colaciones-config-files'
    and public.is_privileged_admin()
  );

create policy "colaciones_config_files_storage_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'colaciones-config-files'
    and public.is_privileged_admin()
  );
