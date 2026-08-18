-- Gate D — segundo hardening: selector binario 1h/2h exclusivo de Producción
-- (lunes-viernes, HH50, matriz exacta de minutos), marcaciones faltantes con
-- red flag auditable, y refuerzo de attendance_corrections como mecanismo
-- único de corrección auditada/inmutable. Migración append-only: ninguna
-- migración anterior se modifica (incluida 20260818160000, que ya estaba
-- pendiente y se corrigió en el mismo archivo por tratarse de defectos
-- confirmados sobre una migración aún no comprometida — ver PASO 1 del
-- informe). Todo lo de abajo es CREATE/ALTER nuevo.
--
-- Alcance explícito (sigue sin existir un motor de cálculo automático que
-- genere overtime_records/attendance_records desde cero — fase futura no
-- iniciada):
--   1. Columnas nuevas en overtime_decisions para registrar la propuesta
--      automática y la marca de revisión obligatoria.
--   2. Funciones puras de la matriz de Producción (propuesta automática,
--      necesidad de revisión manual).
--   3. Extensión de validate_overtime_decision(): constraint binario
--      {0,60,120} exclusivo de Producción lunes-viernes HH50, motivo
--      obligatorio en las excepciones exactas del encargo, y bloqueo de
--      aprobación sobre una marcación incompleta.
--   4. attendance_effective_punches: vista crudo vs. efectivo (crudo +
--      última corrección vigente), sin alterar jamás el dato crudo.
--   5. attendance_corrections: se REUTILIZA (no se crea una tabla paralela)
--      — se le agregan columnas/checks/triggers para satisfacer el contrato
--      completo pedido (tipo de corrección, rol del autor, validaciones de
--      zona horaria/orden, bloqueo en período cerrado, bloqueo si existe una
--      decisión de horas extra activa referenciando el mismo hecho).
--   6. attendance_missing_punch_flags: tabla nueva — red flag visible con
--      ciclo de vida (pendiente de contacto/contactado/resuelto/no resuelto),
--      creada automáticamente, resoluble solo por RRHH o el jefe
--      correspondiente.
--
-- IMPORTANTE (regla del encargo): las reglas numéricas de abajo son políticas
-- internas confirmadas por Sebastián/Arcotex, NO una declaración de
-- cumplimiento legal chileno de horas extra/feriados/remuneraciones. Deben
-- validarse con RR. HH./asesoría legal antes de producción.

-- =============================================================================
-- 1. COLUMNAS NUEVAS EN overtime_decisions
-- =============================================================================
-- Aditivas, nullable/con default — no rompe ninguna fila existente. Solo se
-- pueblan cuando la decisión cae en el alcance exacto del selector binario
-- (ver validate_overtime_decision() más abajo); en cualquier otro caso
-- (Instalación, fin de semana, feriado, HH100, o candidato < 60 minutos)
-- quedan NULL/false, reflejando honestamente que el selector no aplicó.
alter table public.overtime_decisions
  add column system_proposed_minutes integer,
  add column requires_manual_review boolean not null default false;

comment on column public.overtime_decisions.system_proposed_minutes is
  'Propuesta automática del sistema (60 o 120) para el selector binario de '
  'Producción lunes-viernes HH50. NULL si esta decisión no cae en ese '
  'alcance exacto (Instalación, fin de semana, feriado, HH100, o candidato '
  '< 60 minutos, donde el encargo pide explícitamente "no inventar una hora '
  'aprobable").';
comment on column public.overtime_decisions.requires_manual_review is
  'true únicamente cuando el candidato real está en la ventana 115-117 '
  'minutos (candidato a 3-5 minutos de completar 2 horas) — la matriz exige '
  'revisión obligatoria en esa ventana exacta, independientemente de si la '
  'decisión final aprueba 60 o 120.';

-- =============================================================================
-- 2. FUNCIONES PURAS DE LA MATRIZ DE PRODUCCIÓN (lunes-viernes, HH50)
-- =============================================================================
-- No acceden a ninguna tabla — LANGUAGE SQL IMMUTABLE, sin SECURITY DEFINER
-- (no hay superficie de RLS/privilegio que proteger en un cálculo puro sobre
-- un entero). search_path fijo igualmente, por higiene consistente con el
-- resto del esquema.
create or replace function public.production_two_hour_proposal_minutes(
  p_candidate_minutes integer
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_candidate_minutes < 60 then null   -- "no inventar una hora aprobable"
    when p_candidate_minutes <= 117 then 60    -- 60-114 y 115-117: propuesta 60
    else 120                                   -- 118-120 y > 120: propuesta 120
  end;
$$;

comment on function public.production_two_hour_proposal_minutes(integer) is
  'Propuesta automática de la matriz de Producción lunes-viernes HH50 (Gate '
  'D, segundo hardening). < 60: NULL (no se inventa una hora aprobable). '
  '60-117: 60. >= 118 (incluye > 120, donde el dato real se conserva pero el '
  'máximo aprobable sigue siendo 120): 120.';

create or replace function public.production_two_hour_requires_manual_review(
  p_candidate_minutes integer
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_candidate_minutes between 115 and 117;
$$;

comment on function public.production_two_hour_requires_manual_review(integer) is
  'true si el candidato real está en la ventana 115-117 minutos (a 3-5 '
  'minutos de completar 2 horas) — revisión obligatoria exigida por la '
  'matriz de Producción, independientemente de la decisión final.';

grant execute on function
  public.production_two_hour_proposal_minutes(integer),
  public.production_two_hour_requires_manual_review(integer)
to authenticated;
revoke all on function
  public.production_two_hour_proposal_minutes(integer),
  public.production_two_hour_requires_manual_review(integer)
from anon, public;

-- =============================================================================
-- 3. attendance_corrections — REUTILIZADA (no se crea tabla paralela)
-- =============================================================================
-- La tabla ya existente (Fase 3, 20260817152123_attendance_corrections.sql)
-- ya satisface: referencia al hecho original inmutable, valor corregido,
-- motivo NOT NULL, autor forzado a auth.uid() (RLS), timestamp, versionado
-- is_current (inmutable tras insertar salvo ese campo, mismo patrón que el
-- resto del esquema). Lo que le falta para el contrato completo del encargo
-- se agrega aquí, sin duplicar la tabla:
--   - rol del autor en el momento de corregir (no se puede derivar de forma
--     confiable después, si el rol de esa persona cambia más adelante).
--   - tipo de corrección (entrada/salida/ambas) como columna consultable,
--     hoy solo derivable implícitamente de qué campo es NOT NULL.
--   - motivo no vacío (NOT NULL no impide '').
--   - orden/zona horaria: el corregido debe caer en work_date (o, para la
--     salida, permitir turno nocturno hasta el día siguiente) en hora de
--     Chile explícitamente.
--   - bloqueo en período cerrado.
--   - bloqueo si ya existe una decisión de horas extra vigente con minutos
--     aprobados > 0 sobre el mismo hecho: se prefiere fallar con un
--     conflicto controlado (regla explícita del encargo, "no inventar una
--     estrategia de actualización" sobre decisiones append-only) antes que
--     mutar en silencio una decisión ya tomada — RRHH debe invalidar
--     explícitamente la decisión vigente (UPDATE is_current=false, mecanismo
--     ya existente) antes de poder registrar la corrección.

-- Rol del autor al momento de corregir. DEFAULT que lee el rol real vía
-- current_user_role() (nunca un valor de cliente, regla 9 del encargo) —
-- seguro porque la policy de INSERT ya exige can_manage_employee, que a su
-- vez exige un rol no nulo (ADMIN_RRHH o supervisor del grupo
-- correspondiente), así que toda corrección NUEVA queda con este campo
-- poblado automáticamente en la práctica.
--
-- NULLABLE, no NOT NULL — corrección de un defecto real encontrado con
-- Matrix B (aplicar esta migración sobre una base con `attendance_corrections`
-- legacy YA POBLADA antes de que este campo existiera): un ALTER TABLE ...
-- ADD COLUMN NOT NULL DEFAULT current_user_role() intenta poblar (backfill)
-- las filas EXISTENTES evaluando el DEFAULT en la sesión de la migración
-- (sin `request.jwt.claim.sub`), que resuelve a NULL — violando NOT NULL y
-- abortando la migración completa sobre cualquier base con correcciones
-- legacy. No existe (ni se inventa aquí) una forma retroactiva de saber qué
-- rol tenía el autor de una corrección histórica — NULL para filas legacy es
-- la representación honesta de "no capturado en su momento", no un dato
-- perdido ni inventado.
alter table public.attendance_corrections
  add column corrected_by_role public.app_role default public.current_user_role();

comment on column public.attendance_corrections.corrected_by_role is
  'Rol del autor AL MOMENTO de registrar la corrección (snapshot, nunca '
  'recalculado después). Nunca confiado del cliente: DEFAULT lee '
  'current_user_role(), que resuelve el rol real desde profiles vía '
  'auth.uid(). NULLABLE: filas legacy anteriores a esta columna (o '
  'insertadas fuera de un contexto con rol resuelto) quedan NULL — '
  '"no capturado", nunca inventado retroactivamente.';

-- Tipo de corrección, derivado (no confiado del cliente, no duplicado
-- manualmente) de qué campo(s) vienen no nulos — misma información que ya
-- exige el CHECK attendance_corrections_at_least_one_field_chk, expuesta
-- ahora como columna consultable/indexable para el futuro contrato de UI.
alter table public.attendance_corrections
  add column correction_type text generated always as (
    case
      when corrected_clock_in is not null and corrected_clock_out is not null then 'AMBAS'
      when corrected_clock_in is not null then 'ENTRADA'
      else 'SALIDA'
    end
  ) stored;

comment on column public.attendance_corrections.correction_type is
  'ENTRADA/SALIDA/AMBAS — derivado (GENERATED ALWAYS) de qué campo(s) vienen '
  'no nulos, nunca un valor de cliente independiente que pudiera '
  'desalinearse.';

-- Postgres recalcula una columna GENERATED ALWAYS ... STORED DESPUÉS de que
-- corren los triggers BEFORE UPDATE, no antes — el trigger genérico
-- enforce_immutable_columns() (Fase 2, reutilizado sin modificar el archivo
-- original) compara old vs "new" de TODAS las columnas no listadas como
-- mutables, y ve un valor de correction_type aún no recalculado para NEW,
-- lo que produce un falso positivo de "columna inmutable modificada" en
-- cualquier UPDATE (incluido el propio toggle de is_current) aunque
-- corrected_clock_in/out no cambien. Fix: se recrea el trigger (DROP +
-- CREATE, no se edita la migración original) incluyendo 'correction_type'
-- en la lista de columnas exceptuadas — no porque el negocio permita
-- cambiarla libremente (sigue derivándose determinísticamente de
-- corrected_clock_in/out, que SÍ siguen protegidos), sino porque comparar
-- una columna generada dentro de un trigger BEFORE es estructuralmente poco
-- fiable en Postgres.
drop trigger attendance_corrections_immutable on public.attendance_corrections;
create trigger attendance_corrections_immutable
  before update on public.attendance_corrections
  for each row
  execute function public.enforce_immutable_columns('is_current', 'correction_type');

-- Motivo no vacío: NOT NULL (ya existente) no impide una cadena vacía.
alter table public.attendance_corrections
  add constraint attendance_corrections_reason_not_blank_chk
  check (btrim(reason) <> '');

-- Zona horaria de Chile explícita + no cruzar de día silenciosamente. La
-- entrada corregida debe caer en el mismo work_date (hora de Chile); la
-- salida corregida puede caer en work_date o, a lo sumo, el día siguiente
-- (turno que cruza medianoche) — nunca más allá, lo que indicaría un error
-- de tipeo de fecha, no un turno real.
alter table public.attendance_corrections
  add constraint attendance_corrections_clock_in_same_day_chk
  check (
    corrected_clock_in is null
    or (corrected_clock_in at time zone 'America/Santiago')::date = work_date
  );

alter table public.attendance_corrections
  add constraint attendance_corrections_clock_out_reasonable_day_chk
  check (
    corrected_clock_out is null
    or (corrected_clock_out at time zone 'America/Santiago')::date
       between work_date and work_date + 1
  );

-- Bloqueo en período cerrado — mismo criterio ya usado para el motor de bono
-- (20260818160000): falla explícitamente (P0001, sin nombre de constraint ni
-- SQLSTATE interno filtrado), nunca muta en silencio.
create or replace function public.prevent_attendance_correction_on_closed_period()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_period_closed  boolean;
  v_conflict       boolean;
begin
  -- Serialización + error de dominio genérico ante una carrera de dos
  -- correcciones concurrentes sobre el MISMO attendance_record_id — mismo
  -- criterio ya aplicado a overtime_decisions (ver validate_overtime_decision()
  -- más abajo). CONFIRMADO EMPÍRICAMENTE con dos sesiones reales de
  -- PostgreSQL (docker exec, pg_stat_activity) durante este hardening: sin
  -- este advisory lock, la segunda transacción termina bloqueada en
  -- wait_event=transactionid contra el índice único parcial
  -- attendance_corrections_current_key y, al desbloquearse, recibe el error
  -- crudo de Postgres "23505 duplicate key value violates unique constraint
  -- attendance_corrections_current_key" — filtrando el nombre interno de la
  -- constraint. El advisory lock serializa ambas transacciones por
  -- attendance_record_id (namespace 2, distinto de los namespaces 0 y 1 ya
  -- usados por recompute_employee_daily_bonus y validate_overtime_decision,
  -- para no colisionar hashes entre los tres mecanismos de lock) y esta
  -- prevalidación devuelve un error de dominio genérico apenas la segunda
  -- transacción obtiene el lock y ve que la primera ya insertó su corrección
  -- vigente.
  perform pg_advisory_xact_lock(
    hashtextextended(new.attendance_record_id::text, 2)
  );

  select exists (
    select 1 from public.attendance_corrections
    where attendance_record_id = new.attendance_record_id
      and is_current
  ) into v_conflict;

  if v_conflict then
    raise exception
      'An active correction already exists for this attendance record. Ask ADMIN_RRHH to review and invalidate it before registering a new one.';
  end if;

  -- Bloqueo si ya existe una decisión de horas extra vigente con minutos
  -- aprobados > 0 sobre el mismo attendance_record: conflicto controlado en
  -- vez de "mantener silenciosamente una aprobación vieja incompatible" o
  -- inventar una mutación sobre decisiones append-only (regla explícita del
  -- encargo). RRHH debe invalidar la decisión vigente primero (mecanismo ya
  -- existente, is_current=false), lo que además retira automáticamente el
  -- bono ya otorgado (trigger overtime_decisions_recompute_bonus, Gate D) —
  -- solo entonces la corrección puede registrarse y una futura decisión
  -- nueva puede tomarse sobre el dato ya corregido.
  --
  -- CORRECCIÓN (reproducida y confirmada empíricamente con dos sesiones
  -- reales, PASO 8 escenario 3 del encargo): esta comprobación originalmente
  -- vivía en un trigger SEPARADO (attendance_corrections_prevent_active_
  -- decision_conflict). Postgres ejecuta los triggers BEFORE ROW de una
  -- misma tabla en orden alfabético por nombre — ese trigger separado corría
  -- ANTES del advisory lock (adquirido en ESTE trigger, alfabéticamente
  -- posterior), así que su lectura de overtime_decisions podía ejecutarse
  -- ANTES de que la transacción concurrente de aprobación hubiera
  -- confirmado, viendo "sin conflicto" y dejando pasar la corrección aunque
  -- la aprobación se confirmara microsegundos después. Fix: se fusiona esta
  -- comprobación DENTRO de este mismo trigger, DESPUÉS de adquirir el
  -- advisory lock — garantiza que valida_overtime_decision() (que adquiere
  -- el mismo lock namespace 2 antes de aprobar minutos > 0) y esta
  -- comprobación queden genuinamente serializadas entre sí.
  select exists (
    select 1
    from public.overtime_decisions od
    join public.overtime_records ovr on ovr.id = od.overtime_record_id
    where ovr.attendance_record_id = new.attendance_record_id
      and ovr.is_current
      and od.is_current
      and od.approved_minutes > 0
  ) into v_conflict;

  if v_conflict then
    raise exception
      'Cannot register a correction for attendance_record %: an active overtime decision with approved minutes already exists for it. Ask ADMIN_RRHH to invalidate that decision first so the daily bonus is retracted and the corrected punch can be re-evaluated.',
      new.attendance_record_id;
  end if;

  select exists (
    select 1 from public.reporting_periods rp
    where rp.status = 'CLOSED'
      and new.work_date between rp.period_start and rp.period_end
  ) into v_period_closed;

  if v_period_closed then
    raise exception
      'Cannot register an attendance correction for work_date %: reporting period is CLOSED',
      new.work_date;
  end if;

  return new;
end;
$$;

comment on function public.prevent_attendance_correction_on_closed_period() is
  'Serializa (advisory lock por attendance_record_id, namespace 2 — mismo '
  'namespace que adquiere validate_overtime_decision() antes de aprobar '
  'minutos > 0) y bloquea INSERT de attendance_corrections que (a) colisione '
  'con una corrección vigente ya existente, (b) colisione con una decisión '
  'de horas extra vigente con minutos aprobados > 0, o (c) cuyo work_date '
  'caiga en un reporting_period CLOSED — todas como error de dominio '
  'genérico, nunca un 23505 crudo ni una condición de carrera silenciosa '
  '(las tres, confirmadas empíricamente con dos sesiones reales durante '
  'este hardening, incluyendo un reordenamiento de trigger corregido — ver '
  'comentario arriba). Falla en vez de mutar en silencio, mismo criterio que '
  'recompute_employee_daily_bonus().';

create trigger attendance_corrections_prevent_closed_period
  before insert on public.attendance_corrections
  for each row
  execute function public.prevent_attendance_correction_on_closed_period();

-- =============================================================================
-- 4. attendance_effective_punches — crudo vs. efectivo
-- =============================================================================
-- El dato crudo de Workera (attendance_records.actual_clock_in/out) NUNCA se
-- sobrescribe (principio no negociable, Fase 2). Esta vista expone AMBOS: el
-- crudo (raw_clock_in/out, sin tocar) y el efectivo (coalesce con la última
-- corrección vigente, si existe) — el resto del sistema (ej.
-- validate_overtime_decision() más abajo) debe consultar el efectivo, nunca
-- solo el crudo, para decidir si una marcación está completa.
create view public.attendance_effective_punches
with (security_invoker = true)
as
select
  ar.id as attendance_record_id,
  ar.employee_id,
  ar.work_date,
  ar.actual_clock_in as raw_clock_in,
  ar.actual_clock_out as raw_clock_out,
  coalesce(ac.corrected_clock_in, ar.actual_clock_in) as effective_clock_in,
  coalesce(ac.corrected_clock_out, ar.actual_clock_out) as effective_clock_out,
  ac.id as current_correction_id
from public.attendance_records ar
left join public.attendance_corrections ac
  on ac.attendance_record_id = ar.id and ac.is_current;

comment on view public.attendance_effective_punches is
  'Crudo (raw_clock_in/out, tal como llegó de Workera, jamás alterado) vs. '
  'efectivo (coalesce con la corrección vigente, si existe). security_invoker '
  '= true: respeta el RLS del usuario que consulta, igual criterio que '
  'late_arrival_daily_totals (Fase 2A).';

grant select on public.attendance_effective_punches to authenticated;
revoke all on public.attendance_effective_punches from anon;

-- =============================================================================
-- 5. attendance_missing_punch_flags — red flag de marcación incompleta
-- =============================================================================
create type public.missing_punch_type as enum (
  'MISSING_CLOCK_IN', 'MISSING_CLOCK_OUT', 'MISSING_BOTH'
);

create type public.missing_punch_status as enum (
  'PENDING_CONTACT', 'CONTACTED', 'RESOLVED', 'UNRESOLVED'
);

comment on type public.missing_punch_status is
  'Ciclo de vida de una red flag de marcación incompleta: PENDING_CONTACT '
  '(default, recién detectada) -> CONTACTED (RRHH/jefe ya contactó al '
  'trabajador) -> RESOLVED (se registró una attendance_corrections que '
  'completa el dato, o se resolvió manualmente); UNRESOLVED = estado final '
  'explícito para "no se pudo resolver" (ej. el trabajador ya no está '
  'disponible), distinto de dejarla simplemente pendiente para siempre.';

create table public.attendance_missing_punch_flags (
  id                    uuid primary key default gen_random_uuid(),
  attendance_record_id  uuid not null references public.attendance_records(id),
  employee_id           uuid not null references public.employees(id),
  work_date             date not null,
  missing_type          public.missing_punch_type not null,
  status                public.missing_punch_status not null default 'PENDING_CONTACT',

  contacted_by          uuid references public.profiles(id),
  contacted_at          timestamptz,
  resolved_by           uuid references public.profiles(id),
  resolved_at           timestamptz,
  notes                 text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint attendance_missing_punch_flags_record_key unique (attendance_record_id)
);

comment on table public.attendance_missing_punch_flags is
  'Red flag visible a nivel de datos (PASO 3 del encargo) para un '
  'attendance_record con actual_clock_in y/o actual_clock_out en NULL. Se '
  'crea automáticamente (trigger sobre attendance_records), NUNCA se trata '
  'como ausencia definitiva ni se resuelve sola — solo RRHH o el jefe '
  'correspondiente (can_manage_employee) puede avanzar su estado. El dato '
  'crudo referenciado (attendance_records) nunca se sobrescribe: resolver '
  'una flag significa registrar una attendance_corrections que aporta el '
  'valor efectivo, no editar el hecho original.';

create trigger attendance_missing_punch_flags_set_updated_at
  before update on public.attendance_missing_punch_flags
  for each row
  execute function public.set_updated_at();

create index attendance_missing_punch_flags_employee_work_date_idx
  on public.attendance_missing_punch_flags (employee_id, work_date);
create index attendance_missing_punch_flags_open_idx
  on public.attendance_missing_punch_flags (status)
  where status <> 'RESOLVED';

alter table public.attendance_missing_punch_flags enable row level security;

create policy attendance_missing_punch_flags_select on public.attendance_missing_punch_flags
  for select to authenticated using (public.is_corporate_user());

-- UPDATE: solo RRHH o el jefe cuyo grupo coincide con el trabajador de la
-- flag (mismo criterio de autorización que decisiones/correcciones,
-- can_manage_employee) — "solamente RRHH y el jefe correspondiente pueden
-- resolverla" (regla 2 del encargo, PASO 3).
create policy attendance_missing_punch_flags_update on public.attendance_missing_punch_flags
  for update to authenticated
  using (public.is_admin_rrhh() or public.can_manage_employee(employee_id))
  with check (public.is_admin_rrhh() or public.can_manage_employee(employee_id));

revoke all on table public.attendance_missing_punch_flags from anon, authenticated;
grant select, update on public.attendance_missing_punch_flags to authenticated;
-- Sin INSERT/DELETE para authenticated: se crea únicamente vía el trigger
-- interno de abajo (SECURITY DEFINER) al detectarse una marcación
-- incompleta, nunca directamente por un cliente — mismo patrón que
-- employee_daily_bonuses.

-- Autodetección al insertarse el hecho crudo (attendance_records es
-- insert-mostly: cada versión nueva dispara esta evaluación de nuevo).
create or replace function public.flag_missing_attendance_punch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_missing_type public.missing_punch_type;
begin
  if new.actual_clock_in is null and new.actual_clock_out is null then
    v_missing_type := 'MISSING_BOTH';
  elsif new.actual_clock_in is null then
    v_missing_type := 'MISSING_CLOCK_IN';
  elsif new.actual_clock_out is null then
    v_missing_type := 'MISSING_CLOCK_OUT';
  else
    return new; -- marcación completa: no se crea flag
  end if;

  insert into public.attendance_missing_punch_flags
    (attendance_record_id, employee_id, work_date, missing_type)
  values
    (new.id, new.employee_id, new.work_date, v_missing_type)
  on conflict (attendance_record_id) do nothing;

  return new;
end;
$$;

comment on function public.flag_missing_attendance_punch() is
  'Crea automáticamente una attendance_missing_punch_flags cuando un '
  'attendance_record nuevo llega con clock_in y/o clock_out en NULL. NUNCA '
  'inventa un valor ni trata la ausencia de marcación como una ausencia '
  'definitiva — solo señaliza para revisión humana.';

revoke all on function public.flag_missing_attendance_punch() from public;

create trigger attendance_records_flag_missing_punch
  after insert on public.attendance_records
  for each row
  execute function public.flag_missing_attendance_punch();

-- Resolución automática de la flag cuando una corrección autorizada
-- completa AMBOS valores efectivos — sigue exigiendo que la corrección la
-- haya insertado un actor autorizado (RLS de attendance_corrections ya
-- exige can_manage_employee), así que esto no relaja "solo RRHH/jefe
-- correspondiente puede resolver": simplemente evita el paso manual
-- redundante de además marcar la flag a mano tras una corrección que ya
-- resuelve el problema.
create or replace function public.resolve_missing_punch_flag_on_correction()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_effective_in  timestamptz;
  v_effective_out timestamptz;
begin
  select effective_clock_in, effective_clock_out
    into v_effective_in, v_effective_out
  from public.attendance_effective_punches
  where attendance_record_id = new.attendance_record_id;

  if v_effective_in is not null and v_effective_out is not null then
    update public.attendance_missing_punch_flags
    set status = 'RESOLVED', resolved_by = new.corrected_by, resolved_at = new.corrected_at
    where attendance_record_id = new.attendance_record_id
      and status <> 'RESOLVED';
  end if;

  return new;
end;
$$;

comment on function public.resolve_missing_punch_flag_on_correction() is
  'Marca RESOLVED la flag de marcación incompleta cuando una corrección '
  'autorizada (ya pasó por can_manage_employee vía RLS) deja ambos valores '
  'efectivos no nulos. No relaja la autorización: la corrección misma ya '
  'requirió un actor autorizado para existir.';

revoke all on function public.resolve_missing_punch_flag_on_correction() from public;

create trigger attendance_corrections_resolve_missing_punch_flag
  after insert on public.attendance_corrections
  for each row
  execute function public.resolve_missing_punch_flag_on_correction();

-- Fuerza contacted_by/resolved_by al auth.uid() real cuando el estado
-- transiciona a CONTACTED/RESOLVED vía UPDATE manual — nunca un valor de
-- cliente (regla 9 del encargo), mismo criterio que decided_by/corrected_by
-- en el resto del esquema.
create or replace function public.enforce_missing_punch_flag_actor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'CONTACTED' and old.status is distinct from 'CONTACTED' then
    new.contacted_by := auth.uid();
    new.contacted_at := now();
  end if;
  if new.status = 'RESOLVED' and old.status is distinct from 'RESOLVED' then
    new.resolved_by := auth.uid();
    new.resolved_at := now();
  end if;
  return new;
end;
$$;

comment on function public.enforce_missing_punch_flag_actor() is
  'Fuerza contacted_by/contacted_at y resolved_by/resolved_at al auth.uid()/'
  'now() reales del actor que realiza la transición de estado, nunca un '
  'valor enviado por el cliente.';

create trigger attendance_missing_punch_flags_enforce_actor
  before update on public.attendance_missing_punch_flags
  for each row
  execute function public.enforce_missing_punch_flag_actor();

-- =============================================================================
-- 6. SELECTOR BINARIO DE PRODUCCIÓN + BLOQUEO POR MARCACIÓN INCOMPLETA
-- =============================================================================
-- Reemplaza (CREATE OR REPLACE) la validate_overtime_decision() ya corregida
-- en 20260818160000 (hallazgos #2 y #3 de la segunda auditoría), agregando:
--   a) el constraint binario {0,60,120} exclusivo de Producción
--      lunes-viernes HH50, con la EXCEPCIÓN NARROW de "redondeo hacia
--      arriba" que la matriz exige explícitamente: para candidato real en
--      [115,119] minutos, aprobar 120 significa pagar MÁS de lo
--      literalmente trabajado (una aprobación excepcional de 2 horas
--      completas) — esto requiere desactivar, únicamente en ese caso exacto,
--      las dos comprobaciones genéricas "approved <= candidate" y
--      "approved + rejected = candidate" que de otra forma lo rechazarían
--      estructuralmente. Fuera de esa ventana exacta, ambas comprobaciones
--      genéricas se mantienen intactas.
--   b) motivo obligatorio en las excepciones exactas del encargo.
--   c) bloqueo de aprobación cuando la marcación EFECTIVA (crudo + última
--      corrección vigente) sigue incompleta.
create or replace function public.validate_overtime_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_candidate           integer;
  v_employee_id         uuid;
  v_work_date           date;
  v_overtime_type_id    uuid;
  v_group_code          text;
  v_max                 integer;
  v_overtime_50_id      uuid;
  v_is_binary_scope     boolean;
  v_is_rounding_up      boolean;
  v_system_proposal     integer;
  v_requires_review     boolean;
  v_missing_punch       boolean;
  v_attendance_record_id uuid;
begin
  -- Serialización + error de dominio genérico ante una carrera de decisiones
  -- (corrección de la segunda auditoría, hallazgo #3 — ver
  -- 20260818160000 para el detalle completo).
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(
      hashtextextended(new.overtime_record_id::text, 1)
    );

    if exists (
      select 1 from public.overtime_decisions
      where overtime_record_id = new.overtime_record_id
        and is_current
    ) then
      raise exception
        'An active overtime decision already exists for this overtime record. Ask ADMIN_RRHH to review and invalidate it before creating a new one.';
    end if;
  end if;

  select ovr.candidate_minutes, ovr.employee_id, ovr.work_date, ovr.overtime_type_id, ovr.attendance_record_id
    into v_candidate, v_employee_id, v_work_date, v_overtime_type_id, v_attendance_record_id
  from public.overtime_records ovr
  where ovr.id = new.overtime_record_id;

  if v_candidate is null then
    raise exception 'overtime_record % not found', new.overtime_record_id;
  end if;

  -- CORRECCIÓN (reproducida y confirmada empíricamente con dos sesiones
  -- reales durante el hardening, PASO 8 escenario 3 del encargo): sin este
  -- lock, "aprobar horas extra" y "registrar una corrección" sobre el MISMO
  -- attendance_record usaban locks/checks completamente independientes
  -- (esta función solo bloqueaba por overtime_record_id; la corrección solo
  -- por attendance_record_id) — dos transacciones concurrentes podían
  -- COMMITEAR ambas sin que ninguna viera el cambio no confirmado de la
  -- otra (ventana TOCTOU bajo READ COMMITTED), resultando en una decisión
  -- aprobada Y una corrección registrada sobre el mismo hecho sin que
  -- ninguna bloqueara a la otra. Fix: se adquiere el MISMO namespace de
  -- advisory lock que usa prevent_attendance_correction_on_closed_period()
  -- (namespace 2, keyed por attendance_record_id) — ambos caminos de
  -- escritura ahora compiten por el mismo lock antes de sus respectivas
  -- comprobaciones, serializándolos genuinamente entre sí.
  if tg_op = 'INSERT' and new.approved_minutes > 0 then
    perform pg_advisory_xact_lock(
      hashtextextended(v_attendance_record_id::text, 2)
    );
  end if;

  select eg.code into v_group_code
  from public.employees e
  join public.employee_groups eg on eg.id = e.employee_group_id
  where e.id = v_employee_id;

  select id into v_overtime_50_id from public.overtime_types where code = 'OVERTIME_50';

  v_is_binary_scope :=
    v_group_code = 'PRODUCTION'
    and v_overtime_type_id = v_overtime_50_id
    and extract(dow from v_work_date) between 1 and 5;

  -- Redondeo excepcional hacia 120: SOLO cuando el candidato real está en
  -- [115,119] y la decisión aprueba exactamente 120 — la única situación en
  -- la que "aprobado" supera legítimamente el dato real candidateado.
  v_is_rounding_up :=
    v_is_binary_scope
    and v_candidate between 115 and 119
    and new.approved_minutes = 120;

  if not v_is_rounding_up and new.approved_minutes > v_candidate then
    raise exception
      'approved_minutes (%) cannot exceed candidate_minutes (%) for overtime_record %',
      new.approved_minutes, v_candidate, new.overtime_record_id;
  end if;

  if not v_is_rounding_up and (new.approved_minutes + new.rejected_minutes <> v_candidate) then
    raise exception
      'approved_minutes + rejected_minutes (%) must equal candidate_minutes (%) for overtime_record %',
      new.approved_minutes + new.rejected_minutes, v_candidate, new.overtime_record_id;
  end if;

  -- Se pasa v_overtime_type_id (YA CONGELADO en el overtime_record) — ver
  -- corrección del hallazgo #2 en 20260818160000.
  v_max := public.max_approvable_overtime_minutes(v_group_code, v_work_date, v_overtime_type_id);

  if v_max is not null and new.approved_minutes > v_max then
    raise exception
      'approved_minutes (%) exceeds the maximum approvable overtime minutes (%) for group % on % (overtime_record %)',
      new.approved_minutes, v_max, v_group_code, v_work_date, new.overtime_record_id;
  end if;

  -- ---------------------------------------------------------------------
  -- Selector binario 1h/2h — EXCLUSIVO Producción lunes-viernes HH50.
  -- Candidato < 60: el encargo pide explícitamente "no inventar una hora
  -- aprobable" — se deja pasar por la validación genérica de arriba, sin
  -- constraint binario ni motivo obligatorio.
  if v_is_binary_scope and v_candidate >= 60 then
    v_system_proposal := public.production_two_hour_proposal_minutes(v_candidate);
    v_requires_review := public.production_two_hour_requires_manual_review(v_candidate);

    if new.approved_minutes not in (0, 60, 120) then
      raise exception
        'PRODUCTION overtime Monday-Friday (HH50): approved_minutes must be 0 (reject), 60, or 120 — got % for % real minutes',
        new.approved_minutes, v_candidate;
    end if;

    -- Motivo obligatorio exactamente en los tres casos que el encargo lista:
    -- aprobar 120 con menos de 118 minutos reales (la ventana 115-117,
    -- redondeo excepcional); reducir una propuesta de 120 a 60 aprobados;
    -- rechazar (0 aprobados).
    if new.approved_minutes = 120 and v_candidate < 118
       and (new.reason is null or btrim(new.reason) = '') then
      raise exception
        'Approving 120 minutes with only % real minutes (below 118) requires a mandatory reason (exceptional approval, 115-117 window)',
        v_candidate;
    end if;
    if new.approved_minutes = 60 and v_candidate >= 118
       and (new.reason is null or btrim(new.reason) = '') then
      raise exception
        'Reducing a 120-minute system proposal to 60 approved minutes (% real minutes) requires a mandatory reason',
        v_candidate;
    end if;
    if new.approved_minutes = 0
       and (new.reason is null or btrim(new.reason) = '') then
      raise exception
        'Rejecting a PRODUCTION overtime decision (Monday-Friday, HH50) requires a mandatory reason';
    end if;

    new.system_proposed_minutes := v_system_proposal;
    new.requires_manual_review := v_requires_review;
  end if;

  -- ---------------------------------------------------------------------
  -- Marcación incompleta bloquea la aprobación de horas extra (PASO 3 del
  -- encargo: "un registro con marcación incompleta no debe generar horas
  -- extra automáticamente hasta ser corregido y aprobado"). Regla GENERAL,
  -- no exclusiva de Producción — se evalúa el dato EFECTIVO (crudo + última
  -- corrección vigente): una corrección ya registrada por un actor
  -- autorizado SÍ debe permitir continuar; el crudo solo, no.
  if new.approved_minutes > 0 then
    select (effective_clock_in is null or effective_clock_out is null)
      into v_missing_punch
    from public.attendance_effective_punches aep
    join public.overtime_records ovr2 on ovr2.attendance_record_id = aep.attendance_record_id
    where ovr2.id = new.overtime_record_id;

    if coalesce(v_missing_punch, true) then
      raise exception
        'Cannot approve overtime minutes for overtime_record %: the underlying attendance record has an incomplete (missing clock-in or clock-out) punch. Resolve it via an authorized attendance_corrections entry first.',
        new.overtime_record_id;
    end if;
  end if;

  return new;
end;
$$;

-- El trigger ya existente (overtime_decisions_validate, 20260817140540) sigue
-- apuntando a esta misma función por nombre — CREATE OR REPLACE es
-- suficiente, no se recrea el trigger.
