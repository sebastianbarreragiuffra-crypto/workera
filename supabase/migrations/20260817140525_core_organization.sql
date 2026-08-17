-- Fase 2 — 01: núcleo organizacional
-- Extensiones, identidad mínima (placeholder pre-Auth), catálogo de grupos de trabajador,
-- y trabajadores (fuente de verdad: Workera).
--
-- Decisiones documentadas en docs/DATA_MODEL_PHASE2.md — no se repiten aquí en detalle.

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists btree_gist; -- EXCLUDE ... USING gist con columnas de igualdad + rangos

-- ---------------------------------------------------------------------------
-- profiles
--
-- Placeholder mínimo de identidad para Fase 2. NO es el sistema de autenticación
-- final: Fase 3 agregará `profiles.auth_user_id` (FK a auth.users) y RLS. Se crea
-- ahora solo para poder referenciar de forma segura (FK real, no un uuid suelto)
-- a quién aprueba/corrige/decide en las tablas de esta fase, evitando así una
-- migración riesgosa de "agregar FK sobre columnas ya pobladas" más adelante:
-- en Fase 3 solo se AGREGAN columnas (auth_user_id, etc.), nunca se reconstruye
-- esta tabla ni las FKs que ya apuntan a ella.
create table public.profiles (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null,
  role         text not null check (role in ('admin', 'supervisor')),
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

comment on table public.profiles is
  'Placeholder de identidad pre-Fase 3. Sin vínculo a auth.users ni RLS todavía.';

-- ---------------------------------------------------------------------------
-- employee_groups (EmployeeGroup)
--
-- Catálogo, NO enum de Postgres: es una clasificación de negocio que puede crecer
-- (docs/BUSINESS_RULES_PRE_PHASE2.md sección 1). Es la llave real de las políticas
-- (overtime_policies, late_arrival_policies), no `department`/`cost_center` de Workera.
create table public.employee_groups (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.employee_groups is
  'Catálogo de clasificación de trabajador (ADMINISTRATION/PRODUCTION, extensible). '
  'Llave de OvertimePolicy/LateArrivalPolicy — nunca usar department/cost_center de '
  'Workera directamente en lógica de negocio.';

-- ---------------------------------------------------------------------------
-- employees (Employee)
--
-- Fuente de verdad: Workera (docs/PRE_FASE2_WORKERA_VALIDATION.md sección 7).
-- Minimización de datos: sin email, teléfono, dirección ni ningún dato no
-- requerido por los documentos de negocio.
create table public.employees (
  id                  uuid primary key default gen_random_uuid(),

  -- Todo empleado se origina en una sincronización de Workera; el id externo
  -- es la clave de idempotencia del upsert (docs/PRE_FASE2_WORKERA_VALIDATION.md
  -- sección 8). NOT NULL: no se contempla en Fase 2 la creación manual de
  -- trabajadores sin Workera — si ese caso aparece, es una decisión de Fase 5
  -- (sincronización), no de este esquema.
  external_workera_id text not null,

  -- RUT normalizado (sin puntos, con guión, dígito verificador en mayúscula).
  -- Nullable: no todos los trabajadores tienen RUT disponible o confiable desde
  -- Workera (checklist pendiente, PRE_FASE2_WORKERA_VALIDATION.md sección 5).
  rut                 text,

  first_name          text not null,
  last_name           text not null,
  display_name        text not null,

  -- Nullable a propósito: la sincronización debe poder crear el registro crudo
  -- del trabajador aunque todavía no se sepa su grupo (Workera puede no
  -- entregarlo de forma confiable — BUSINESS_RULES_PRE_PHASE2.md P1 #14).
  -- "Trabajador sin employee_group" es una validación BLOCKING a nivel de
  -- DailyReview (fase futura), no una restricción NOT NULL aquí: forzar NOT NULL
  -- rompería la idempotencia del sync cuando Workera no entrega el dato.
  employee_group_id   uuid references public.employee_groups(id),

  active              boolean not null default true,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint employees_external_workera_id_key unique (external_workera_id),
  constraint employees_rut_format_chk
    check (rut is null or rut ~ '^[0-9]{7,8}-[0-9K]$')
);

create unique index employees_rut_key
  on public.employees (rut)
  where rut is not null;

create index employees_employee_group_id_idx
  on public.employees (employee_group_id);

comment on table public.employees is
  'Datos maestros del trabajador. Fuente de verdad: Workera. Sin diagnóstico médico '
  'ni datos personales no requeridos (minimización de datos).';
comment on column public.employees.rut is
  'Normalizado como XXXXXXXX-X (7-8 dígitos, guión, dígito verificador 0-9 o K).';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger employees_set_updated_at
  before update on public.employees
  for each row
  execute function public.set_updated_at();
