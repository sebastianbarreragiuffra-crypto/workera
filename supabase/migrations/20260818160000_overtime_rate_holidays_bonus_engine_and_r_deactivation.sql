-- Gate D — reglas autoritativas de horas extra, bono diario, feriados y
-- desactivación del código R (confirmadas por el usuario, resuelven varios P0
-- de docs/DECISIONS_PENDING.md). Migración append-only: ninguna migración
-- anterior se modifica; todo lo de abajo es CREATE/ALTER/INSERT/UPDATE nuevo.
--
-- Alcance explícito de esta migración (no se construye motor de cálculo
-- completo, que sigue siendo una fase futura no iniciada):
--   1. Calendario de feriados administrativos (tabla nueva + RLS).
--   2. Clasificación HH50/HH100 server-side, determinista, no elegible por el
--      cliente (función + trigger sobre overtime_records).
--   3. Máximo aprobable de horas extra por grupo+fecha (función pura,
--      enforced en el trigger ya existente validate_overtime_decision()).
--   4. Motor de bono diario automático (antes NO automatizado a propósito,
--      per comentario original de 20260817144423_production_overtime_bonus.sql
--      — ahora se automatiza porque el usuario confirmó la regla completa,
--      incluyendo recomputación ante corrección y garantía de un único bono).
--   5. Desactivación del código de asistencia "R" para nuevas asignaciones.
--
-- IMPORTANTE (regla 17 del encargo): las reglas numéricas de abajo son
-- políticas internas confirmadas por Sebastián/Arcotex, NO una declaración de
-- cumplimiento legal chileno de horas extra/feriados. Deben validarse con
-- RR. HH./asesoría legal antes de producción — ver docs/DECISIONS_PENDING.md.

-- =============================================================================
-- 1. CALENDARIO DE FERIADOS ADMINISTRATIVOS
-- =============================================================================
-- No existía ningún concepto de feriado/calendario en el esquema (confirmado
-- por auditoría exhaustiva de las 24 migraciones previas). Tabla mínima,
-- mismo patrón que otros catálogos administrables (employee_groups, etc.):
-- desactivar en vez de borrar preserva la clasificación histórica de fechas
-- ya usadas en decisiones/bonos pasados.
create table public.holidays (
  id            uuid primary key default gen_random_uuid(),
  holiday_date  date not null,
  name          text not null,
  active        boolean not null default true,

  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint holidays_date_key unique (holiday_date)
);

comment on table public.holidays is
  'Calendario administrativo de feriados (Gate D). Una fecha marcada aquí y '
  'activa se clasifica HH100 aunque caiga de lunes a sábado. Desactivar '
  '(active=false) en vez de borrar preserva la clasificación histórica de '
  'decisiones/bonos ya calculados sobre esa fecha.';

create trigger holidays_set_updated_at
  before update on public.holidays
  for each row
  execute function public.set_updated_at();

alter table public.holidays enable row level security;

-- Lectura: cualquier corporativo (los supervisores necesitan poder consultar
-- por qué un día se clasificó HH100). Escritura: solo ADMIN_RRHH — mismo
-- patrón exacto que work_schedules/overtime_policies/bonus_policies
-- (20260817152249_rls_catalogs_and_policies.sql).
create policy holidays_select on public.holidays
  for select to authenticated using (public.is_corporate_user());
create policy holidays_write_admin on public.holidays
  for all to authenticated
  using (public.is_admin_rrhh()) with check (public.is_admin_rrhh());

revoke all on table public.holidays from anon, authenticated;
grant select, insert, update on public.holidays to authenticated;
-- Sin DELETE: desactivar (active=false) preserva mejor el historial que
-- borrar, mismo criterio ya aplicado a supporting_documents en Fase 3.

-- =============================================================================
-- 2. CLASIFICACIÓN HH50/HH100 — server-side, determinista, no elegible por
--    el cliente
-- =============================================================================
-- Regla confirmada: HH50 = lunes a sábado sin feriado. HH100 = domingo, o
-- cualquier día (incluso lunes-sábado) marcado feriado activo — el feriado
-- prevalece. p_work_date es `date` puro (sin componente horario), por lo que
-- extract(dow from ...) no sufre el problema de conversión UTC que sí
-- afectaría a un timestamptz: no hay zona horaria que convertir sobre un
-- `date` ya resuelto como día calendario.
create or replace function public.classify_overtime_type_id(p_work_date date)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select ot.id
  from public.overtime_types ot
  where ot.code = (
    case
      when exists (
        select 1 from public.holidays h
        where h.holiday_date = p_work_date and h.active
      ) then 'OVERTIME_100'
      when extract(dow from p_work_date) = 0 then 'OVERTIME_100' -- domingo
      else 'OVERTIME_50'
    end
  );
$$;

comment on function public.classify_overtime_type_id(date) is
  'Clasifica una fecha calendario en OVERTIME_50/OVERTIME_100 (Gate D). '
  'Feriado activo prevalece sobre día de semana. Determinista, sin input del '
  'cliente — el trigger overtime_records_classify_rate la aplica siempre, '
  'ignorando cualquier overtime_type_id propuesto en el INSERT/UPDATE.';

revoke all on function public.classify_overtime_type_id(date) from public;
grant execute on function public.classify_overtime_type_id(date) to authenticated;

-- Trigger: sobrescribe SIEMPRE overtime_type_id según work_date, sin importar
-- qué haya propuesto el llamador — "el cliente no puede elegir arbitrariamente
-- HH50 o HH100" se cumple estructuralmente, no por convención.
create or replace function public.enforce_overtime_type_classification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.overtime_type_id := public.classify_overtime_type_id(new.work_date);
  if new.overtime_type_id is null then
    raise exception
      'No overtime_type catalog entry found to classify work_date % (missing OVERTIME_50/OVERTIME_100 seed)',
      new.work_date;
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_overtime_type_classification() from public;

create trigger overtime_records_classify_rate
  before insert or update of work_date on public.overtime_records
  for each row
  execute function public.enforce_overtime_type_classification();

-- Defensa en profundidad: un único overtime_record vigente por trabajador+día
-- (antes el índice único solo cubría employee_id+work_date+overtime_type_id;
-- ahora que el tipo es 100% determinado por la fecha, dos candidatos
-- "vigentes" el mismo día ya no tiene sentido de negocio y se bloquea también
-- a nivel de constraint, no solo por la clasificación determinista).
create unique index overtime_records_current_per_day_key
  on public.overtime_records (employee_id, work_date)
  where is_current;

-- =============================================================================
-- 3. MÁXIMO APROBABLE DE HORAS EXTRA POR GRUPO + FECHA
-- =============================================================================
-- overtime_policies (day_of_week-based) no puede expresar "un feriado de
-- martes se limita a 360, no a 120" — day_of_week no sabe de feriados. Se
-- implementa como función pura de negocio, independiente de overtime_policies
-- (que sigue existiendo para elegibilidad/candidatos futuros, sin cambiar su
-- semántica). NULL = sin límite fijo automático (Instalación, por regla
-- explícita del usuario: "no inventar un límite fijo").
-- CORRECCIÓN (segunda auditoría, hallazgo #2 CONFIRMADO): la versión
-- original recibía solo (group_code, work_date) y volvía a llamar a
-- classify_overtime_type_id(work_date) EN VIVO. Como el trigger
-- overtime_records_classify_rate solo congela overtime_type_id en el INSERT/
-- UPDATE OF work_date del registro, si el calendario de feriados cambia
-- DESPUÉS de que el registro ya existe, el tope aprobable evaluado aquí podía
-- divergir retroactivamente de la clasificación real ya almacenada — ej.: se
-- crea el overtime_record un día marcado feriado (HH100, tope 360);
-- alguien desactiva el feriado antes de que RRHH decida; la decisión vería
-- tope 120 aunque el registro siga diciendo HH100. Fix: recibe el
-- overtime_type_id YA CONGELADO en el overtime_record (tercer parámetro) en
-- vez de recalcularlo — un cambio posterior del calendario nunca altera el
-- máximo aprobable de una decisión sobre un registro ya existente.
create or replace function public.max_approvable_overtime_minutes(
  p_employee_group_code text,
  p_work_date date,
  p_overtime_type_id uuid
)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select
    case p_employee_group_code
      when 'PRODUCTION' then
        case
          when p_overtime_type_id =
               (select id from public.overtime_types where code = 'OVERTIME_100')
            then 360 -- domingo o feriado (según la clasificación YA congelada)
          when extract(dow from p_work_date) between 1 and 5 then 120 -- lunes-viernes, HH50
          when extract(dow from p_work_date) = 6 then 360 -- sábado, HH50
          else null
        end
      -- INSTALLATION: sin límite fijo automático (regla explícita del
      -- usuario). Cualquier otro grupo (incl. ADMINISTRATION o sin grupo
      -- asignado): también NULL — esta función solo IMPONE un tope donde el
      -- usuario confirmó explícitamente uno (PRODUCTION); no inventa un
      -- bloqueo de 0 minutos para casos no cubiertos por la regla de negocio
      -- descrita. La no-elegibilidad de ADMINISTRATION sigue viviendo, sin
      -- cambios, en overtime_policies.overtime_eligible (nivel candidato).
      else null
    end;
$$;

comment on function public.max_approvable_overtime_minutes(text, date, uuid) is
  'Máximo de minutos de horas extra APROBABLES (no candidateados) por grupo, '
  'fecha y la clasificación HH50/HH100 YA CONGELADA en el overtime_record '
  '(Gate D, corregido en el segundo hardening — ya no recalcula el feriado en '
  'vivo, ver comentario arriba). PRODUCTION: 120 lunes-viernes, 360 sábado/'
  'domingo/feriado. Cualquier otro grupo (incluida INSTALLATION, y cualquier '
  'caso sin grupo clasificado): NULL = sin tope automático impuesto por esta '
  'función. El dato original importado/candidateado '
  '(overtime_records.candidate_minutes) NUNCA se altera por este límite: se '
  'aplica solo a approved_minutes en overtime_decisions, vía '
  'validate_overtime_decision() extendida abajo.';

revoke all on function public.max_approvable_overtime_minutes(text, date, uuid) from public;
grant execute on function public.max_approvable_overtime_minutes(text, date, uuid) to authenticated;

-- Extiende (CREATE OR REPLACE, no toca el archivo original) la validación
-- cruzada ya existente: mismas dos comprobaciones previas, más el nuevo tope
-- aprobable. Se RECHAZA explícitamente el exceso (no se limita en silencio) —
-- decisión documentada aquí per instrucción de "no introducir una conducta
-- silenciosa ambigua": un supervisor que intenta aprobar más del máximo ve un
-- error claro, no una aprobación recortada sin aviso.
create or replace function public.validate_overtime_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_candidate        integer;
  v_employee_id      uuid;
  v_work_date        date;
  v_overtime_type_id uuid;
  v_group_code       text;
  v_max              integer;
begin
  -- CORRECCIÓN (segunda auditoría, hallazgo #3 CONFIRMADO): antes, dos
  -- INSERT concurrentes sobre el mismo overtime_record_id competían
  -- directamente contra el índice único parcial overtime_decisions_current_key
  -- — el perdedor de la carrera recibía el error crudo de Postgres
  -- "23505 duplicate key value violates unique constraint
  -- overtime_decisions_current_key", exponiendo el nombre interno de la
  -- constraint. Fix: un advisory lock transaccional serializa ambas
  -- transacciones por overtime_record_id (namespace 1, distinto del usado por
  -- recompute_employee_daily_bonus más abajo, namespace 0, para no colisionar
  -- hashes entre los dos mecanismos de lock), y una prevalidación explícita
  -- devuelve un error de dominio genérico (P0001, sin nombre de constraint ni
  -- SQLSTATE interno) apenas la segunda transacción obtiene el lock y ve que
  -- la primera ya insertó su decisión vigente. Solo aplica a INSERT — un
  -- UPDATE (solo ADMIN_RRHH, solo is_current) no compite por "crear la
  -- primera decisión vigente".
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

  select ovr.candidate_minutes, ovr.employee_id, ovr.work_date, ovr.overtime_type_id
    into v_candidate, v_employee_id, v_work_date, v_overtime_type_id
  from public.overtime_records ovr
  where ovr.id = new.overtime_record_id;

  if v_candidate is null then
    raise exception 'overtime_record % not found', new.overtime_record_id;
  end if;

  if new.approved_minutes > v_candidate then
    raise exception
      'approved_minutes (%) cannot exceed candidate_minutes (%) for overtime_record %',
      new.approved_minutes, v_candidate, new.overtime_record_id;
  end if;

  if new.approved_minutes + new.rejected_minutes <> v_candidate then
    raise exception
      'approved_minutes + rejected_minutes (%) must equal candidate_minutes (%) for overtime_record %',
      new.approved_minutes + new.rejected_minutes, v_candidate, new.overtime_record_id;
  end if;

  select eg.code into v_group_code
  from public.employees e
  join public.employee_groups eg on eg.id = e.employee_group_id
  where e.id = v_employee_id;

  -- Se pasa v_overtime_type_id (YA CONGELADO en el overtime_record) en vez de
  -- dejar que la función recalcule el feriado en vivo — ver corrección arriba
  -- de max_approvable_overtime_minutes.
  v_max := public.max_approvable_overtime_minutes(v_group_code, v_work_date, v_overtime_type_id);

  if v_max is not null and new.approved_minutes > v_max then
    raise exception
      'approved_minutes (%) exceeds the maximum approvable overtime minutes (%) for group % on % (overtime_record %)',
      new.approved_minutes, v_max, v_group_code, v_work_date, new.overtime_record_id;
  end if;

  return new;
end;
$$;

-- El trigger ya existente (overtime_decisions_validate, 20260817140540) sigue
-- apuntando a esta misma función por nombre — CREATE OR REPLACE es suficiente,
-- no se recrea el trigger.

-- ---------------------------------------------------------------------------
-- Completa la elegibilidad de PRODUCTION: hoy solo existía lunes-jueves
-- (viernes/sábado/domingo quedaban sin fila = NEEDS_REVIEW, P0 pendiente en
-- docs/DECISIONS_PENDING.md). El usuario confirmó viernes con el mismo tope
-- que lunes-jueves (120 min) y sábado/domingo con 360 min. No colisiona con
-- la fila existente (EXCLUDE es por employee_group_id+day_of_week+rango; los
-- day_of_week 5/6/0 no tenían ninguna fila previa).
insert into public.overtime_policies
  (employee_group_id, day_of_week, overtime_eligible, max_overtime_minutes, effective_from)
select eg.id, d.day_of_week, true, d.max_minutes, date '2026-01-01'
from public.employee_groups eg
cross join (values (5, 120), (6, 360), (0, 360)) as d(day_of_week, max_minutes)
where eg.code = 'PRODUCTION';

-- INSTALLATION no tenía NINGUNA fila de overtime_policies sembrada (P0
-- pendiente). max_overtime_minutes aquí es un techo TÉCNICO de generación de
-- candidatos (columna NOT NULL cuando overtime_eligible=true, requisito de
-- esquema preexistente) — NO es el máximo aprobable real: la autoridad de
-- aprobación real de Instalación es el supervisor asignado, sin tope fijo
-- automático (ver max_approvable_overtime_minutes(), que devuelve NULL para
-- INSTALLATION independientemente de este valor). Se usa 1440 (24h, el
-- máximo matemático de un día) para dejar explícito que no es una regla de
-- negocio inventada, solo satisface el requisito estructural de la columna.
insert into public.overtime_policies
  (employee_group_id, day_of_week, overtime_eligible, max_overtime_minutes, effective_from)
select eg.id, d.day_of_week, true, 1440, date '2026-01-01'
from public.employee_groups eg
cross join (values (0), (1), (2), (3), (4), (5), (6)) as d(day_of_week)
where eg.code = 'INSTALLATION';

-- =============================================================================
-- 4. MOTOR DE BONO DIARIO AUTOMÁTICO
-- =============================================================================
-- El comentario original de 20260817144423_production_overtime_bonus.sql
-- documentaba deliberadamente "NO se automatiza... es una fase futura". Esa
-- fase es esta: el usuario confirmó la regla completa (umbral, monto fijo,
-- recomputación ante corrección, un único bono por trabajador+fecha,
-- aplicable a PRODUCTION e INSTALLATION). Se automatiza ahora con una función
-- SECURITY DEFINER + trigger, siguiendo el mismo patrón ya usado para
-- handle_new_auth_user() (Fase 3): la tabla sigue sin GRANT de escritura para
-- `authenticated` (ningún usuario puede crear/editar un bono directamente),
-- pero el trigger definer puede, de forma acotada y auditable.

-- Bono también para INSTALLATION (regla confirmada por el usuario). Se
-- reutiliza el mismo bonus_type (el "tipo" de bono es el mismo concepto —
-- umbral de minutos aprobados — para ambos grupos; bonus_policies ya
-- diferencia por employee_group_id, no hace falta un tipo nuevo). Se
-- actualiza el nombre para reflejar que ya no es exclusivo de Producción; el
-- code se conserva sin cambios para no romper ninguna referencia existente.
update public.bonus_types
set name = 'Bono diario por horas extra aprobadas (Producción e Instalación)'
where code = 'PRODUCTION_DAILY_OVERTIME_BONUS';

insert into public.bonus_policies
  (bonus_type_id, employee_group_id, trigger_type, threshold_minutes, amount, currency, effective_from)
select
  bt.id,
  eg.id,
  'APPROVED_OVERTIME_MINUTES_THRESHOLD',
  120,
  1000,
  'CLP',
  date '2026-01-01'
from public.bonus_types bt, public.employee_groups eg
where bt.code = 'PRODUCTION_DAILY_OVERTIME_BONUS'
  and eg.code = 'INSTALLATION';

-- Defensa en profundidad: además del unique(overtime_decision_id) ya
-- existente (Fase 2B) y del lock consultivo del motor de recomputación (más
-- abajo), un constraint único directo garantiza "nunca más de un bono POR
-- TIPO DE BONO, por trabajador y fecha" al nivel más fuerte posible (íntegro
-- en el motor de almacenamiento), independiente de cualquier lógica de
-- aplicación.
--
-- CORRECCIÓN (segunda auditoría, hallazgo #1 CONFIRMADO): la versión
-- original de este constraint era unique(employee_id, work_date) — sin
-- bonus_policy_id. bonus_types/bonus_policies está diseñado explícitamente
-- para soportar múltiples tipos de bono futuros sin alterar el esquema (ver
-- comentario de bonus_types en 20260817144423_production_overtime_bonus.sql:
-- "Permite agregar bonos futuros sin alterar el esquema"), y
-- bonus_policies_no_overlap (misma migración) ya delimita el solapamiento
-- por (bonus_type_id, employee_group_id, rango de vigencia) — es decir, DOS
-- bonus_type distintos SÍ pueden aplicar simultáneamente al mismo
-- employee_group en la misma fecha sin violar ese constraint. Un
-- unique(employee_id, work_date) sin bonus_policy_id bloquearía
-- incorrectamente un segundo tipo de bono legítimo el mismo día (ej. un
-- futuro bono de asistencia perfecta coexistiendo con este bono de horas
-- extra). Hoy, con un único trigger_type confirmado
-- (APPROVED_OVERTIME_MINUTES_THRESHOLD), el efecto práctico es idéntico —
-- pero el constraint debe expresar la regla de negocio real ("nunca más de
-- un bono de ESTE tipo por trabajador y fecha"), no una coincidencia
-- circunstancial del catálogo actual.
alter table public.employee_daily_bonuses
  add constraint employee_daily_bonuses_employee_work_date_policy_key
  unique (employee_id, work_date, bonus_policy_id);

-- ---------------------------------------------------------------------------
-- recompute_employee_daily_bonus: recomputación completa (no incremental)
-- desde las filas autoritativas actuales, con lock explícito en orden estable
-- por (employee_id, work_date) para serializar recomputaciones concurrentes
-- del mismo trabajador+fecha.
create or replace function public.recompute_employee_daily_bonus(
  p_employee_id uuid,
  p_work_date date
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group_id           uuid;
  v_group_code         text;
  v_decision_id        uuid;
  v_approved_minutes   integer;
  v_policy_id          uuid;
  v_policy_amount      bigint;
  v_policy_currency    text;
  v_policy_threshold   integer;
  v_period_closed      boolean;
  v_existing_bonus_id  uuid;
begin
  -- Lock explícito en orden estable (hash del par employee_id+work_date):
  -- serializa dos recomputaciones concurrentes del mismo trabajador+fecha sin
  -- bloquear recomputaciones de otros trabajadores/fechas.
  perform pg_advisory_xact_lock(
    hashtextextended(p_employee_id::text || ':' || p_work_date::text, 0)
  );

  select eg.id, eg.code
    into v_group_id, v_group_code
  from public.employees e
  join public.employee_groups eg on eg.id = e.employee_group_id
  where e.id = p_employee_id;

  if v_group_code is null or v_group_code not in ('PRODUCTION', 'INSTALLATION') then
    return; -- el bono no aplica a otros grupos sin una regla explícita adicional
  end if;

  -- Período cerrado: falla en vez de mutar en silencio (regla 7 del encargo).
  select exists (
    select 1 from public.reporting_periods rp
    where rp.status = 'CLOSED'
      and p_work_date between rp.period_start and rp.period_end
  ) into v_period_closed;

  -- Decisión vigente (autoritativa) para ese trabajador+fecha, si existe.
  select od.id, od.approved_minutes
    into v_decision_id, v_approved_minutes
  from public.overtime_decisions od
  join public.overtime_records ovr on ovr.id = od.overtime_record_id
  where ovr.employee_id = p_employee_id
    and ovr.work_date = p_work_date
    and ovr.is_current
    and od.is_current;

  select bp.id, bp.amount, bp.currency, bp.threshold_minutes
    into v_policy_id, v_policy_amount, v_policy_currency, v_policy_threshold
  from public.bonus_policies bp
  where bp.employee_group_id = v_group_id
    and bp.trigger_type = 'APPROVED_OVERTIME_MINUTES_THRESHOLD'
    and p_work_date >= bp.effective_from
    and (bp.effective_to is null or p_work_date <= bp.effective_to)
  limit 1;

  select id into v_existing_bonus_id
  from public.employee_daily_bonuses
  where employee_id = p_employee_id and work_date = p_work_date;

  if v_decision_id is not null
     and v_policy_id is not null
     and v_approved_minutes >= v_policy_threshold
  then
    if v_existing_bonus_id is null then
      if v_period_closed then
        raise exception
          'Cannot create daily bonus for employee % on %: reporting period is CLOSED',
          p_employee_id, p_work_date;
      end if;
      insert into public.employee_daily_bonuses
        (employee_id, work_date, overtime_decision_id, bonus_policy_id, amount, currency)
      values
        (p_employee_id, p_work_date, v_decision_id, v_policy_id, v_policy_amount, v_policy_currency);
    end if;
    -- Ya existe: employee_daily_bonuses es inmutable por diseño (Fase 2B) y el
    -- monto es fijo por política, no proporcional — no hay nada que recalcular
    -- en el monto de un bono ya otorgado para la MISMA decisión vigente.
  else
    if v_existing_bonus_id is not null then
      if v_period_closed then
        raise exception
          'Cannot remove daily bonus for employee % on %: reporting period is CLOSED',
          p_employee_id, p_work_date;
      end if;
      delete from public.employee_daily_bonuses where id = v_existing_bonus_id;
      insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
      values (
        auth.uid(),
        'DAILY_BONUS_RECOMPUTED_REMOVED',
        'employee_daily_bonuses',
        v_existing_bonus_id,
        jsonb_build_object('employee_id', p_employee_id, 'work_date', p_work_date)
      );
    end if;
  end if;
end;
$$;

comment on function public.recompute_employee_daily_bonus(uuid, date) is
  'Recomputación COMPLETA (no incremental) del bono diario de un trabajador+ '
  'fecha, desde la decisión de horas extra vigente actual. Idempotente: '
  'llamarla dos veces con el mismo estado no crea ni borra nada la segunda '
  'vez. Falla (no muta) si el período de reporte está CLOSED.';

revoke all on function public.recompute_employee_daily_bonus(uuid, date) from public;
-- Sin GRANT a authenticated: se invoca únicamente desde el trigger interno de
-- abajo, nunca directamente por un cliente.

create or replace function public.trigger_recompute_employee_daily_bonus()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_employee_id uuid;
  v_work_date   date;
begin
  select ovr.employee_id, ovr.work_date
    into v_employee_id, v_work_date
  from public.overtime_records ovr
  where ovr.id = coalesce(new.overtime_record_id, old.overtime_record_id);

  if v_employee_id is not null then
    perform public.recompute_employee_daily_bonus(v_employee_id, v_work_date);
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function public.trigger_recompute_employee_daily_bonus() from public;

create trigger overtime_decisions_recompute_bonus
  after insert or update on public.overtime_decisions
  for each row
  execute function public.trigger_recompute_employee_daily_bonus();

comment on trigger overtime_decisions_recompute_bonus on public.overtime_decisions is
  'Gate D: automatiza la creación/retiro del bono diario a partir de la '
  'decisión de horas extra vigente. Corre AFTER (la validación cruzada '
  'validate_overtime_decision y employee_daily_bonuses_validate ya se '
  'ejecutaron antes de este punto). SECURITY DEFINER: el supervisor que '
  'aprueba/corrige nunca necesita privilegio directo sobre employee_daily_bonuses.';

-- =============================================================================
-- 5. DESACTIVACIÓN DEL CÓDIGO "R" (recuperan horas)
-- =============================================================================
-- La empresa confirmó que no usa recuperación de horas. No se elimina la fila
-- (rompería FKs de attendance_status_records históricos y el catálogo) — se
-- desactiva, y se bloquea su asignación en operaciones NUEVAS únicamente.
update public.attendance_statuses
set active = false
where code = 'R';

comment on column public.attendance_statuses.active is
  'Catálogo activo/inactivo. "R" (Recuperan horas) está desactivado desde '
  'Gate D: la empresa no usa recuperación de horas. Los registros históricos '
  'que ya usan "R" se preservan intactos (attendance_status_records nunca se '
  'borra) — solo se bloquean NUEVAS asignaciones (ver trigger '
  'attendance_status_records_prevent_inactive).';

create or replace function public.prevent_inactive_attendance_status_assignment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_active boolean;
  v_code   text;
begin
  select active, code into v_active, v_code
  from public.attendance_statuses
  where id = new.attendance_status_id;

  if v_active is false then
    raise exception
      'attendance_status "%" is inactive and cannot be assigned to new attendance_status_records',
      v_code;
  end if;

  return new;
end;
$$;

comment on function public.prevent_inactive_attendance_status_assignment() is
  'Gate D: bloquea SOLO INSERT de attendance_status_records nuevos que '
  'referencien un attendance_status inactivo (ej. "R"). No se dispara en '
  'UPDATE — los registros históricos existentes nunca se tocan ni se '
  'revalidan retroactivamente.';

create trigger attendance_status_records_prevent_inactive
  before insert on public.attendance_status_records
  for each row
  execute function public.prevent_inactive_attendance_status_assignment();
