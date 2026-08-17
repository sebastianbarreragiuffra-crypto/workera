-- Fase 3 — 15: attendance_corrections (completa un vacío de Fase 2A)
--
-- docs/DATA_MODEL_PHASE2.md ya documentaba conceptualmente "AttendanceCorrection"
-- como el mecanismo para corregir una marcación sin alterar el hecho original
-- de Workera, pero la tabla nunca se implementó en las migraciones de Fase 2A.
-- El encargo de Fase 3 (secciones 10, 32) exige explícitamente que exista este
-- mecanismo para poder otorgar permisos de escritura de forma segura — se
-- crea ahora, como una migración nueva de Fase 3 (no se toca ninguna
-- migración de Fase 2A/2B).
create table public.attendance_corrections (
  id                    uuid primary key default gen_random_uuid(),

  -- Referencia a la versión inmutable específica de attendance_records que se
  -- está corrigiendo — mismo patrón que overtime_records/late_arrival_records
  -- (Fase 2A): el hecho original nunca se edita, se referencia.
  attendance_record_id  uuid not null references public.attendance_records(id),

  -- Redundante respecto a attendance_record_id, a propósito: permite políticas
  -- RLS y consultas de autorización (can_manage_employee) sin tener que hacer
  -- join contra attendance_records en cada evaluación de policy.
  employee_id           uuid not null references public.employees(id),
  work_date             date not null,

  corrected_clock_in    timestamptz,
  corrected_clock_out   timestamptz,

  -- Obligatorio (a diferencia de `reason` en otras tablas de decisión, que es
  -- opcional): una corrección que altera el dato usado para remuneraciones
  -- siempre debe quedar justificada por escrito.
  reason                text not null,

  -- Nunca confiar en un valor de cliente (sección 11/37 del encargo): default
  -- auth.uid() para conveniencia, y la policy RLS de INSERT (migración de
  -- políticas de asistencia) exige explícitamente corrected_by = auth.uid().
  corrected_by          uuid not null default auth.uid() references public.profiles(id),
  corrected_at          timestamptz not null default now(),

  -- Mismo patrón is_current que el resto del esquema: una corrección puede a
  -- su vez ser revisada/reemplazada por RRHH (encargo sección 7 — "RRHH
  -- REVIEW/OVERRIDE sin borrar la decisión anterior") insertando una nueva
  -- fila, nunca editando ésta.
  is_current            boolean not null default true,

  created_at            timestamptz not null default now(),

  constraint attendance_corrections_at_least_one_field_chk
    check (corrected_clock_in is not null or corrected_clock_out is not null),
  constraint attendance_corrections_clock_order_chk
    check (
      corrected_clock_in is null or corrected_clock_out is null
      or corrected_clock_out >= corrected_clock_in
    )
);

comment on table public.attendance_corrections is
  'Corrección estructurada sobre una versión específica de attendance_records. '
  'El registro original de Workera NUNCA se modifica (attendance_records sigue '
  'siendo inmutable, Fase 2A) — esta tabla es el único mecanismo permitido '
  'para corregir una marcación.';

create unique index attendance_corrections_current_key
  on public.attendance_corrections (attendance_record_id)
  where is_current;

create index attendance_corrections_employee_work_date_idx
  on public.attendance_corrections (employee_id, work_date);

create trigger attendance_corrections_immutable
  before update on public.attendance_corrections
  for each row
  execute function public.enforce_immutable_columns('is_current');
