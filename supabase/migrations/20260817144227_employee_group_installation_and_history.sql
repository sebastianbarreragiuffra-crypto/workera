-- Fase 2B — 08: grupo INSTALLATION + historial de clasificación de grupo
--
-- Extiende (no reemplaza) el esquema de Fase 2A. No se modifica ninguna de las
-- 7 migraciones de Fase 2A ni sus datos sembrados.

-- ---------------------------------------------------------------------------
-- Nuevo grupo confirmado. employee_groups sigue siendo catálogo (Fase 2A) —
-- agregar un grupo es una fila, no una migración de esquema.
insert into public.employee_groups (code, name) values
  ('INSTALLATION', 'Instalación');

-- ---------------------------------------------------------------------------
-- employee_group_assignments (historial de grupo)
--
-- Decisión: `employees.employee_group_id` (Fase 2A) por sí solo NO alcanza
-- para responder "¿a qué grupo pertenecía este trabajador en una fecha
-- histórica?" — es un único valor sin vigencia. Se agrega esta tabla siguiendo
-- exactamente el mismo patrón ya usado en Fase 2A para `schedule_assignments`
-- y `supervisor_assignments` (vigencia + EXCLUDE anti-solapamiento), en vez de
-- inventar un mecanismo nuevo.
--
-- `employees.employee_group_id` NO se elimina ni se altera: se mantiene como
-- puntero de conveniencia del "grupo actual" (para no romper Fase 2A ni forzar
-- un join en cada consulta simple), documentado explícitamente como un caché
-- que la sincronización futura debe mantener alineado con la fila vigente
-- (`effective_to is null`) de esta tabla. Esta tabla es la fuente de verdad
-- para cualquier consulta con fecha histórica. No se implementa un trigger de
-- sincronización automática entre ambos en esta fase: mantenerlos alineados es
-- responsabilidad de la capa de aplicación/sync (fase futura), igual criterio
-- de "no sobreautomatizar" ya aplicado en Fase 2A.
create table public.employee_group_assignments (
  id                 uuid primary key default gen_random_uuid(),
  employee_id        uuid not null references public.employees(id),
  employee_group_id  uuid not null references public.employee_groups(id),
  effective_from     date not null,
  effective_to       date,

  source             text not null default 'internal' check (source in ('workera', 'internal')),
  sync_run_id        uuid references public.sync_runs(id),

  created_at         timestamptz not null default now(),

  constraint employee_group_assignments_range_chk
    check (effective_to is null or effective_to >= effective_from),

  -- Un trabajador pertenece a un único grupo vigente por fecha.
  constraint employee_group_assignments_no_overlap
    exclude using gist (
      employee_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    )
);

comment on table public.employee_group_assignments is
  'Historial de employee_group por trabajador y vigencia (ej. Juan: enero '
  'PRODUCTION, febrero INSTALLATION). Fuente de verdad para consultas con '
  'fecha histórica. employees.employee_group_id (Fase 2A) se mantiene como '
  'caché del grupo actual, no se elimina.';

create index employee_group_assignments_employee_id_idx
  on public.employee_group_assignments (employee_id);
create index employee_group_assignments_sync_run_id_idx
  on public.employee_group_assignments (sync_run_id);

-- ---------------------------------------------------------------------------
-- Nota sobre supervisores por grupo (sección 6 del encargo):
-- NO se requiere ninguna tabla ni columna nueva. `supervisor_assignments`
-- (Fase 2A) ya relaciona supervisor↔trabajador; "Supervisor Producción ve
-- trabajadores de Producción" emerge naturalmente al hacer JOIN con
-- employees.employee_group_id (o employee_group_assignments para una fecha
-- específica) — el grupo del trabajador ya está disponible sin duplicar el
-- dato en supervisor_assignments. Agregar production_supervisor_id/
-- installation_supervisor_id habría sido exactamente el anti-patrón que el
-- encargo pidió evitar.
