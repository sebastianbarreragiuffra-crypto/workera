-- Fase 2 — 02: horarios, asignaciones históricas y políticas configurables
--
-- Ninguna regla de horario/overtime/atraso vive hardcodeada en código de aplicación
-- (docs/BUSINESS_RULES_PRE_PHASE2.md sección 12). Todo lo que cambia por decisión de
-- negocio (horario, tope de horas extra, tolerancia de atraso) es un dato aquí.

-- ---------------------------------------------------------------------------
-- work_schedules / work_schedule_rules (WorkSchedule)
--
-- Tabla separada de reglas por día de semana en vez de una sola tabla ancha con
-- columnas monday_start/monday_end/...: permite agregar turnos futuros (ej. nocturno)
-- sin alterar columnas, y una jornada con días libres se representa con ausencia de
-- fila (o start/end nulos), no con una columna "is_day_off" adicional por día.
create table public.work_schedules (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.work_schedules is
  'Jornada nombrada (ej. "Horario estándar planta"). El detalle por día vive en '
  'work_schedule_rules.';

create table public.work_schedule_rules (
  id                uuid primary key default gen_random_uuid(),
  work_schedule_id  uuid not null references public.work_schedules(id) on delete cascade,

  -- 0 = domingo .. 6 = sábado (convención ISO-like ampliada; documentado en
  -- docs/DATA_MODEL_PHASE2.md). Se usa smallint, no un catálogo: es un valor
  -- técnico estable (7 valores posibles, nunca cambia), no una clasificación de negocio.
  day_of_week       smallint not null check (day_of_week between 0 and 6),

  -- Ambos nulos = día no laboral en esta jornada. Ambos no nulos = jornada normal.
  -- No se permite uno nulo y el otro no (CHECK abajo).
  scheduled_start   time,
  scheduled_end     time,

  created_at        timestamptz not null default now(),

  constraint work_schedule_rules_unique_day unique (work_schedule_id, day_of_week),
  constraint work_schedule_rules_both_or_neither_chk
    check ((scheduled_start is null) = (scheduled_end is null)),
  -- Asume jornadas dentro del mismo día calendario (no hay turno nocturno confirmado
  -- hoy). Si en el futuro se necesita un turno que cruza medianoche, esta constraint
  -- deberá revisarse — no se generaliza ahora sin un caso real que lo requiera.
  constraint work_schedule_rules_end_after_start_chk
    check (scheduled_start is null or scheduled_end > scheduled_start)
);

comment on table public.work_schedule_rules is
  'Regla de horario por día de semana dentro de un WorkSchedule. Asume jornadas que '
  'no cruzan medianoche (sin caso de turno nocturno confirmado a la fecha).';

-- ---------------------------------------------------------------------------
-- schedule_assignments (ScheduleAssignment)
--
-- Vigencia temporal explícita, no un campo fijo en employees: permite responder
-- "qué horario tenía Juan el 10 de agosto" incluso si después cambió de jornada
-- (docs/BUSINESS_RULES_PRE_PHASE2.md sección 3).
create table public.schedule_assignments (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references public.employees(id),
  work_schedule_id  uuid not null references public.work_schedules(id),
  effective_from    date not null,
  effective_to      date,
  created_at        timestamptz not null default now(),

  constraint schedule_assignments_range_chk
    check (effective_to is null or effective_to >= effective_from),

  -- Un trabajador no puede tener dos jornadas vigentes simultáneamente. Requiere
  -- btree_gist (creada en 01_core_organization.sql) para poder usar `=` sobre uuid
  -- dentro de un EXCLUDE junto a la superposición de rango de fechas.
  constraint schedule_assignments_no_overlap
    exclude using gist (
      employee_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    )
);

comment on table public.schedule_assignments is
  'Historial de qué WorkSchedule tuvo cada trabajador y cuándo. Sin solapamientos '
  '(un trabajador tiene una única jornada vigente en cada fecha).';

create index schedule_assignments_employee_id_idx on public.schedule_assignments (employee_id);

-- ---------------------------------------------------------------------------
-- supervisor_assignments (SupervisorAssignment)
--
-- Relación histórica supervisor↔trabajador (docs/BUSINESS_RULES_PRE_PHASE2.md,
-- PRE_FASE2_WORKERA_VALIDATION.md sección 6): nuestra base es la fuente de verdad
-- operativa, sembrada desde Workera si éste expone el dato de forma confiable.
create table public.supervisor_assignments (
  id                     uuid primary key default gen_random_uuid(),
  employee_id            uuid not null references public.employees(id),
  supervisor_profile_id  uuid not null references public.profiles(id),
  effective_from         date not null,
  effective_to           date,
  source                 text not null default 'internal' check (source in ('workera', 'internal')),
  created_at             timestamptz not null default now(),

  constraint supervisor_assignments_range_chk
    check (effective_to is null or effective_to >= effective_from),

  -- Un trabajador tiene un único supervisor vigente en cada fecha. Si el negocio
  -- confirma que un trabajador puede tener más de un supervisor simultáneo (ej.
  -- cobertura de vacaciones), esta constraint deberá revisarse explícitamente —
  -- no se asume esa flexibilidad sin confirmación.
  constraint supervisor_assignments_no_overlap
    exclude using gist (
      employee_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    )
);

comment on table public.supervisor_assignments is
  'Historial supervisor↔trabajador con vigencia. Fuente de verdad interna, '
  'sembrada desde Workera cuando esté disponible (source=workera).';

create index supervisor_assignments_employee_id_idx on public.supervisor_assignments (employee_id);
create index supervisor_assignments_supervisor_profile_id_idx
  on public.supervisor_assignments (supervisor_profile_id);

-- ---------------------------------------------------------------------------
-- overtime_policies (OvertimePolicy)
--
-- Regla configurable de elegibilidad/tope de horas extra por grupo y día de semana.
-- El límite de 120 minutos NO es un CHECK global (docs/BUSINESS_RULES_PRE_PHASE2.md
-- sección 9) — vive aquí como dato, para no bloquear políticas futuras distintas.
create table public.overtime_policies (
  id                    uuid primary key default gen_random_uuid(),
  employee_group_id     uuid not null references public.employee_groups(id),
  day_of_week           smallint not null check (day_of_week between 0 and 6),
  overtime_eligible     boolean not null,

  -- NULL cuando overtime_eligible = false (no aplica tope si no hay elegibilidad).
  -- Cuando overtime_eligible = true, debe existir un tope explícito — no se asume
  -- "sin límite" por omisión.
  max_overtime_minutes  integer,

  effective_from        date not null,
  effective_to          date,
  created_at            timestamptz not null default now(),

  constraint overtime_policies_range_chk
    check (effective_to is null or effective_to >= effective_from),
  -- Universal: nunca un tope negativo. No es "120", es ">= 0" — la regla configurable
  -- (120 hoy) vive en los datos sembrados (07_seeds.sql), no en esta constraint.
  constraint overtime_policies_max_minutes_chk
    check (max_overtime_minutes is null or max_overtime_minutes >= 0),
  constraint overtime_policies_eligible_requires_max_chk
    check (
      (overtime_eligible = false and max_overtime_minutes is null)
      or (overtime_eligible = true and max_overtime_minutes is not null)
    ),

  constraint overtime_policies_no_overlap
    exclude using gist (
      employee_group_id with =,
      day_of_week with =,
      daterange(effective_from, effective_to, '[]') with &&
    )
);

comment on table public.overtime_policies is
  'Política configurable de horas extra por employee_group + día de semana. '
  'Ausencia de fila para un grupo/día = regla aún no confirmada (ej. viernes de '
  'Producción, ver docs/BUSINESS_RULES_PRE_PHASE2.md P0) — el motor de cálculo '
  '(fase futura) NO debe asumir elegibilidad en ese caso, debe marcar NEEDS_REVIEW.';

create index overtime_policies_group_day_idx
  on public.overtime_policies (employee_group_id, day_of_week);

-- ---------------------------------------------------------------------------
-- late_arrival_policies (LateArrivalPolicy)
create table public.late_arrival_policies (
  id                  uuid primary key default gen_random_uuid(),
  employee_group_id   uuid not null references public.employee_groups(id),
  day_of_week         smallint not null check (day_of_week between 0 and 6),
  tolerance_minutes   integer not null default 0,
  effective_from      date not null,
  effective_to        date,
  created_at          timestamptz not null default now(),

  constraint late_arrival_policies_range_chk
    check (effective_to is null or effective_to >= effective_from),
  constraint late_arrival_policies_tolerance_chk
    check (tolerance_minutes >= 0),

  constraint late_arrival_policies_no_overlap
    exclude using gist (
      employee_group_id with =,
      day_of_week with =,
      daterange(effective_from, effective_to, '[]') with &&
    )
);

comment on table public.late_arrival_policies is
  'Tolerancia de atraso configurable por employee_group + día de semana. '
  'Valor por defecto sembrado: 0 minutos, hasta confirmación de RRHH '
  '(docs/BUSINESS_RULES_PRE_PHASE2.md sección 13).';

create index late_arrival_policies_group_day_idx
  on public.late_arrival_policies (employee_group_id, day_of_week);
