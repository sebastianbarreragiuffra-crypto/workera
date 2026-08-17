-- Fase 2B — 11: bono por horas extra aprobadas (Producción)
--
-- Regla confirmada: PRODUCTION + 120 min de horas extra APROBADAS en un día
-- = $1.000 CLP. Depende de OvertimeDecision.approved_minutes, nunca de
-- clock_out ni de candidate_minutes directamente (encargo, sección 19).
--
-- No se implementa un motor genérico de reglas en JSON: se modela con tablas
-- tipadas y normalizadas (BonusType/BonusPolicy/EmployeeDailyBonus), y NO se
-- automatiza la generación del bono con un trigger sobre overtime_decisions
-- (sección 48 del encargo — "no sobreautomatizar"; la creación del bono es un
-- paso de una fase futura de cálculo). Lo que SÍ se implementa ahora es la
-- validación de integridad de lo que se inserte, porque un bono con impacto
-- económico incorrecto es un problema de integridad, no de automatización de
-- proceso de negocio.

-- ---------------------------------------------------------------------------
-- bonus_types (catálogo, extensible sin migración de esquema)
create table public.bonus_types (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.bonus_types is
  'Catálogo de tipos de bono. Permite agregar bonos futuros sin alterar el '
  'esquema — cada tipo nuevo es una fila, no una tabla nueva, salvo que su '
  'lógica de elegibilidad requiera columnas realmente distintas.';

-- ---------------------------------------------------------------------------
-- bonus_policies — configurable, versionado por vigencia (mismo patrón que
-- overtime_policies/late_arrival_policies de Fase 2A).
create table public.bonus_policies (
  id                 uuid primary key default gen_random_uuid(),
  bonus_type_id      uuid not null references public.bonus_types(id),
  employee_group_id  uuid not null references public.employee_groups(id),

  -- Único trigger_type confirmado hoy. Se modela como valor de catálogo
  -- (CHECK, no un motor de reglas genérico) para no construir infraestructura
  -- que ningún caso real pide todavía; si aparece un segundo tipo de gatillo
  -- con parámetros distintos, se agrega como nueva columna nullable + nuevo
  -- valor permitido, igual que se hizo con overtime_policies en Fase 2A.
  trigger_type       text not null check (trigger_type in ('APPROVED_OVERTIME_MINUTES_THRESHOLD')),
  threshold_minutes  integer check (threshold_minutes is null or threshold_minutes >= 0),

  -- Dinero: entero, nunca float (sección 23). CLP no tiene subunidades en uso
  -- práctico, por lo que `amount` representa pesos completos directamente
  -- (1000 = $1.000 CLP), sin necesidad de un concepto de "unidades menores".
  amount             bigint not null check (amount >= 0),
  currency           text not null default 'CLP' check (currency = 'CLP'),

  effective_from     date not null,
  effective_to       date,
  created_at         timestamptz not null default now(),

  constraint bonus_policies_range_chk
    check (effective_to is null or effective_to >= effective_from),
  constraint bonus_policies_threshold_requires_trigger_chk
    check (trigger_type <> 'APPROVED_OVERTIME_MINUTES_THRESHOLD' or threshold_minutes is not null),

  constraint bonus_policies_no_overlap
    exclude using gist (
      bonus_type_id with =,
      employee_group_id with =,
      daterange(effective_from, effective_to, '[]') with &&
    )
);

comment on table public.bonus_policies is
  'Política de bono configurable por tipo + grupo + vigencia. La regla '
  'PRODUCTION + 120 min aprobados = $1.000 CLP vive aquí como dato (seed más '
  'abajo), no en el esquema. Ausencia de fila para INSTALLATION es '
  'deliberada: el bono para ese grupo está PENDING_BUSINESS_CONFIRMATION '
  '(sección 26 del encargo) — no se asume ni se inventa.';

create index bonus_policies_group_idx on public.bonus_policies (employee_group_id);

-- ---------------------------------------------------------------------------
-- employee_daily_bonuses — resultado auditable (EmployeeDailyBonus)
--
-- Referencia una OvertimeDecision específica e inmutable (Fase 2A): como esa
-- fila nunca cambia tras insertarse, un bono ligado a un overtime_decision_id
-- concreto queda con trazabilidad completa sin necesitar su propia cadena de
-- versiones (`is_current`, etc.) — si Workera cambia el dato subyacente
-- después (sección 25), el mecanismo de SYNC_CONFLICT ya existente en Fase 2A
-- crea una OvertimeDecision nueva con su propio id; el bono anterior queda
-- intacto como historial, y un eventual bono nuevo referenciaría la decisión
-- nueva — nunca se edita ni se borra el bono ya otorgado.
create table public.employee_daily_bonuses (
  id                   uuid primary key default gen_random_uuid(),

  -- Redundante respecto a lo que ya se puede derivar de overtime_decision_id,
  -- a propósito: permite consultar "bonos de este trabajador en este rango de
  -- fechas" sin tener que atravesar overtime_decisions -> overtime_records en
  -- cada consulta. El trigger de validación (más abajo) garantiza que nunca
  -- queda desalineado con la decisión referenciada.
  employee_id          uuid not null references public.employees(id),
  work_date            date not null,

  overtime_decision_id uuid not null references public.overtime_decisions(id),
  bonus_policy_id      uuid not null references public.bonus_policies(id),

  -- Snapshot del monto al momento de otorgar el bono: si la política cambia
  -- de valor más adelante, este bono ya otorgado conserva el monto real
  -- pagado (mismo principio de inmutabilidad que el resto del esquema).
  amount               bigint not null check (amount >= 0),
  currency             text not null default 'CLP' check (currency = 'CLP'),

  granted_at           timestamptz not null default now(),
  created_at           timestamptz not null default now(),

  -- A lo sumo un bono por decisión de horas extra específica (la elegibilidad
  -- es un hecho determinístico de esa decisión + esa política).
  constraint employee_daily_bonuses_decision_key unique (overtime_decision_id)
);

comment on table public.employee_daily_bonuses is
  'Resultado auditable: por qué y cuánto se otorgó. NO se genera '
  'automáticamente por trigger (ver nota superior) — la inserción la realiza '
  'la capa de cálculo en una fase futura; esta tabla valida que lo insertado '
  'sea consistente (trigger de validación cruzada), no que se genere solo.';

create index employee_daily_bonuses_employee_work_date_idx
  on public.employee_daily_bonuses (employee_id, work_date);

-- Completamente inmutable tras insertar: un bono otorgado no se edita. Se
-- reutiliza la misma función de Fase 2A sin argumentos mutables (cualquier
-- columna, incluidas todas, queda protegida).
create trigger employee_daily_bonuses_immutable
  before update on public.employee_daily_bonuses
  for each row
  execute function public.enforce_immutable_columns();

-- ---------------------------------------------------------------------------
-- Validación cruzada (trigger, no CHECK — requiere leer overtime_decisions,
-- overtime_records, overtime_policies y bonus_policies): el bono insertado
-- debe corresponder real y exactamente a la decisión y política referenciadas.
create or replace function public.validate_employee_daily_bonus()
returns trigger
language plpgsql
as $$
declare
  v_approved_minutes  integer;
  v_ot_employee_id    uuid;
  v_ot_work_date      date;
  v_ot_group_id       uuid;
  v_policy            record;
begin
  select
    od.approved_minutes,
    ovr.employee_id,
    ovr.work_date,
    op.employee_group_id
  into
    v_approved_minutes,
    v_ot_employee_id,
    v_ot_work_date,
    v_ot_group_id
  from public.overtime_decisions od
  join public.overtime_records ovr on ovr.id = od.overtime_record_id
  join public.overtime_policies op on op.id = ovr.overtime_policy_id
  where od.id = new.overtime_decision_id;

  if v_ot_employee_id is null then
    raise exception 'overtime_decision % not found', new.overtime_decision_id;
  end if;

  if new.employee_id <> v_ot_employee_id then
    raise exception
      'employee_daily_bonuses.employee_id (%) must match the referenced overtime_decision employee (%)',
      new.employee_id, v_ot_employee_id;
  end if;

  if new.work_date <> v_ot_work_date then
    raise exception
      'employee_daily_bonuses.work_date (%) must match the referenced overtime_decision work_date (%)',
      new.work_date, v_ot_work_date;
  end if;

  select bp.employee_group_id, bp.trigger_type, bp.threshold_minutes,
         bp.amount, bp.currency, bp.effective_from, bp.effective_to
  into v_policy
  from public.bonus_policies bp
  where bp.id = new.bonus_policy_id;

  if v_policy is null then
    raise exception 'bonus_policy % not found', new.bonus_policy_id;
  end if;

  if v_policy.employee_group_id <> v_ot_group_id then
    raise exception
      'bonus_policy employee_group (%) does not match the overtime_policy employee_group (%) used to calculate the referenced overtime_decision',
      v_policy.employee_group_id, v_ot_group_id;
  end if;

  if new.work_date < v_policy.effective_from
     or (v_policy.effective_to is not null and new.work_date > v_policy.effective_to) then
    raise exception
      'bonus_policy % is not effective on work_date %', new.bonus_policy_id, new.work_date;
  end if;

  if v_policy.trigger_type = 'APPROVED_OVERTIME_MINUTES_THRESHOLD'
     and v_approved_minutes < v_policy.threshold_minutes then
    raise exception
      'approved_minutes (%) does not meet bonus_policy threshold (%)',
      v_approved_minutes, v_policy.threshold_minutes;
  end if;

  if new.amount <> v_policy.amount or new.currency <> v_policy.currency then
    raise exception
      'employee_daily_bonuses amount/currency (%/%) must match the bonus_policy at grant time (%/%)',
      new.amount, new.currency, v_policy.amount, v_policy.currency;
  end if;

  return new;
end;
$$;

create trigger employee_daily_bonuses_validate
  before insert on public.employee_daily_bonuses
  for each row
  execute function public.validate_employee_daily_bonus();

-- ---------------------------------------------------------------------------
-- Seed: única regla confirmada hoy. NO se siembra ninguna política para
-- INSTALLATION (PENDING_BUSINESS_CONFIRMATION, sección 26 del encargo).
insert into public.bonus_types (code, name) values
  ('PRODUCTION_DAILY_OVERTIME_BONUS', 'Bono diario por horas extra aprobadas (Producción)');

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
  and eg.code = 'PRODUCTION';
