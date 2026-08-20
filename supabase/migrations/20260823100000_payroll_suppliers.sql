-- =============================================================================
-- Nómina de Pago -- maestro de proveedores + lotes de nómina generados.
-- =============================================================================
--
-- Encargo real (no una fase ficticia): el área de finanzas envía mensualmente
-- un Excel de facturas pendientes (Nro. Docto./Nombre Cliente/Valor Total).
-- Esta tabla es el maestro de datos bancarios de cada proveedor (RUT/forma de
-- pago/banco/cuenta) -- se cruza por NOMBRE exacto normalizado (nunca fuzzy,
-- mismo criterio que `name-matching.ts` ya usa para cumpleaños) porque el
-- Excel mensual de facturas no trae RUT, solo el nombre del proveedor.
--
-- Acceso: solo SUPER_ADMIN/ADMIN_RRHH (`is_privileged_admin()`, ya existente
-- desde Fase 5D) -- datos financieros/bancarios, nunca visibles para
-- supervisores de área.

create table public.suppliers (
  id                uuid primary key default gen_random_uuid(),

  -- RUT tal como lo entrega el archivo de origen -- sin validar formato acá:
  -- el maestro real observado usa un formato numérico propio de finanzas
  -- (no necesariamente el mismo formato RUT-con-guion usado para empleados),
  -- no se asume ni se fuerza un formato no confirmado.
  rut               text not null,
  name              text not null,
  -- Nombre normalizado (mayúsculas/sin acentos/espacios colapsados) -- misma
  -- función `normalizeName` de `src/lib/business-rules/name-matching.ts`,
  -- persistida para que el cruce mensual sea una comparación exacta simple,
  -- nunca una función calculada en cada consulta.
  normalized_name   text not null,

  payment_method    text not null, -- "FP" del archivo real (ej. "OTC")
  bank_code         text not null, -- "BCO"
  account_number    text not null, -- "N° Cuenta Cte."

  active            boolean not null default true,
  created_by        uuid not null references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint suppliers_normalized_name_key unique (normalized_name)
);

comment on table public.suppliers is
  'Maestro de proveedores para Nómina de Pago -- RUT/forma de pago/banco/cuenta '
  'por proveedor. El cruce mensual con el Excel de facturas es por '
  'normalized_name EXACTO, nunca fuzzy -- un nombre sin match queda excluido '
  'y reportado, nunca se adivina.';

create index suppliers_normalized_name_idx on public.suppliers (normalized_name);

alter table public.suppliers enable row level security;

create policy suppliers_select on public.suppliers
  for select to authenticated using (public.is_privileged_admin());
create policy suppliers_write_admin on public.suppliers
  for all to authenticated
  using (public.is_privileged_admin()) with check (public.is_privileged_admin());

create trigger suppliers_set_updated_at
  before update on public.suppliers
  for each row execute function public.set_updated_at();

grant select, insert, update, delete on table public.suppliers to authenticated;

-- =============================================================================
-- Lotes de nómina generados (auditoría: quién generó qué, cuándo, con qué
-- resultado de cruce) -- no se persiste el archivo Excel original, solo los
-- datos ya estructurados que produjo el parseo.
-- =============================================================================

create table public.payroll_batches (
  id                uuid primary key default gen_random_uuid(),
  source_filename   text not null,
  generated_by      uuid not null references public.profiles(id),
  generated_at      timestamptz not null default now(),
  matched_count     integer not null check (matched_count >= 0),
  unmatched_count   integer not null check (unmatched_count >= 0),
  total_amount      bigint not null check (total_amount >= 0)
);

comment on table public.payroll_batches is
  'Un lote = una vez que alguien subió el Excel mensual de facturas y el '
  'sistema generó la nómina de pago cruzando contra suppliers. No guarda el '
  'archivo original -- solo el resultado estructurado (payroll_batch_items).';

alter table public.payroll_batches enable row level security;

create policy payroll_batches_select on public.payroll_batches
  for select to authenticated using (public.is_privileged_admin());
create policy payroll_batches_insert on public.payroll_batches
  for insert to authenticated
  with check (public.is_privileged_admin() and generated_by = auth.uid());

grant select, insert on table public.payroll_batches to authenticated;

create table public.payroll_batch_items (
  id                uuid primary key default gen_random_uuid(),
  batch_id          uuid not null references public.payroll_batches(id),

  nro_docto         text not null,
  nombre_cliente    text not null,
  valor_total       bigint not null check (valor_total >= 0),

  -- null cuando no hubo match exacto en suppliers -- el ítem igual se
  -- persiste (para que el lote sea auditable completo), pero status lo deja
  -- claro y nunca se incluye en la exportación final.
  supplier_id       uuid references public.suppliers(id),
  status            text not null check (status in ('MATCHED', 'UNMATCHED')),

  created_at        timestamptz not null default now(),

  constraint payroll_batch_items_status_supplier_chk
    check ((status = 'MATCHED') = (supplier_id is not null))
);

comment on table public.payroll_batch_items is
  'Una fila del Excel mensual de facturas ya cruzada contra suppliers. '
  'UNMATCHED = el Nombre Cliente no tuvo ningún proveedor con ese '
  'normalized_name exacto en el maestro -- queda excluido de la exportación '
  'final y debe revisarse manualmente, nunca se adivina el proveedor.';

create index payroll_batch_items_batch_id_idx on public.payroll_batch_items (batch_id);

alter table public.payroll_batch_items enable row level security;

create policy payroll_batch_items_select on public.payroll_batch_items
  for select to authenticated using (public.is_privileged_admin());
create policy payroll_batch_items_insert on public.payroll_batch_items
  for insert to authenticated
  with check (
    public.is_privileged_admin()
    and exists (
      select 1 from public.payroll_batches b
      where b.id = payroll_batch_items.batch_id and b.generated_by = auth.uid()
    )
  );

grant select, insert on table public.payroll_batch_items to authenticated;
