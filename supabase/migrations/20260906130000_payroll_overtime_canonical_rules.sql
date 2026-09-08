-- Reglas canónicas de horas extra para la pre-nómina 2026.
--
-- Esta migración reemplaza expresamente decisiones históricas que permitían
-- redondear minutos, pagar Producción en domingo o dejar Instalaciones sin
-- tope durante toda la semana. El tiempo real permanece en
-- overtime_records.candidate_minutes; solo approved_minutes queda acotado.

-- Rol empresarial exacto. Los helpers legacy de `profiles.role` describen el
-- workspace ARCOTEX, pero no bastan cuando una persona pertenece a más de una
-- empresa: una membresía cualquiera nunca hereda el rol de otra empresa.
create or replace function public.has_company_app_role(
  p_company_id uuid,
  p_role public.app_role
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_memberships cm
    join public.companies c on c.id = cm.company_id
    join public.profiles p on p.id = cm.user_id
    join public.company_membership_roles cmr
      on cmr.company_id = cm.company_id and cmr.membership_id = cm.id
    join public.company_roles cr
      on cr.company_id = cmr.company_id and cr.id = cmr.role_id
    where cm.company_id = p_company_id
      and cm.user_id = auth.uid()
      and cm.active
      and c.active
      and c.status in ('ACTIVE', 'ONBOARDING')
      and p.active
      and cr.active
      and cr.base_role = p_role
  );
$$;

comment on function public.has_company_app_role(uuid, public.app_role) is
  'Comprueba el rol laboral asignado dentro de la empresa indicada; nunca '
  'combina profiles.role de ARCOTEX con una membresía de otro tenant.';

revoke all on function public.has_company_app_role(uuid, public.app_role)
  from public, anon;
grant execute on function public.has_company_app_role(uuid, public.app_role)
  to authenticated;

-- NULL significa exclusivamente "sin tope fijo" para Instalaciones en
-- domingo. Cero significa que el grupo/día no es aprobable.
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
  select case
    when p_employee_group_code = 'ADMINISTRATION' then 0
    when p_employee_group_code = 'PRODUCTION'
         and extract(dow from p_work_date) = 0 then 0
    when p_employee_group_code = 'INSTALLATION'
         and extract(dow from p_work_date) = 0
         and p_overtime_type_id = (
           select id from public.overtime_types where code = 'OVERTIME_100'
         ) then null
    when p_employee_group_code in ('PRODUCTION', 'INSTALLATION')
         and p_overtime_type_id = (
           select id from public.overtime_types where code = 'OVERTIME_100'
         ) then 360
    when p_employee_group_code in ('PRODUCTION', 'INSTALLATION')
         and extract(dow from p_work_date) between 1 and 6
         and p_overtime_type_id = (
           select id from public.overtime_types where code = 'OVERTIME_50'
         ) then 120
    else 0
  end;
$$;

comment on function public.max_approvable_overtime_minutes(text, date, uuid) is
  'Tope pagable canónico sin alterar minutos reales: Producción e Instalaciones '
  'L-S HH50=120; feriado HH100=360; domingo Instalaciones HH100 sin tope fijo; '
  'domingo Producción y Administración=0. Usa el tipo congelado del registro.';

revoke all on function public.max_approvable_overtime_minutes(text, date, uuid) from public;
grant execute on function public.max_approvable_overtime_minutes(text, date, uuid) to authenticated;

-- overtime_policies expresa elegibilidad semanal. Los feriados se resuelven
-- en la función anterior porque una fila por day_of_week no puede distinguir
-- un sábado normal de un sábado feriado. El generador conserva siempre el
-- candidato real y no usa max_overtime_minutes para recortarlo.
alter table public.overtime_policies
  drop constraint if exists overtime_policies_eligible_requires_max_chk;

-- Una política elegible puede tener NULL únicamente para representar que la
-- regla vigente no fija un tope. Las políticas no elegibles siguen sin tope.
alter table public.overtime_policies
  add constraint overtime_policies_eligible_requires_max_chk
  check (overtime_eligible or max_overtime_minutes is null);

update public.overtime_policies op
set overtime_eligible = case
      when eg.code = 'PRODUCTION' and op.day_of_week = 0 then false
      else true
    end,
    max_overtime_minutes = case
      when eg.code = 'PRODUCTION' and op.day_of_week = 0 then null
      when eg.code = 'INSTALLATION' and op.day_of_week = 0 then null
      else 120
    end
from public.employee_groups eg
where eg.id = op.employee_group_id
  and eg.code in ('PRODUCTION', 'INSTALLATION');

-- El bono confirmado ya no es una preferencia administrativa: en esta
-- versión de pre-nómina su regla contractual es exactamente 120 minutos y
-- $1.000 CLP para Producción e Instalación. Normalizamos cualquier seed
-- anterior y lo fijamos con un constraint para que un cambio de catálogo no
-- altere silenciosamente dinero ya revisado.
update public.bonus_policies bp
set threshold_minutes = 120,
    amount = 1000,
    currency = 'CLP'
from public.employee_groups eg
where eg.id = bp.employee_group_id
  and eg.code in ('PRODUCTION', 'INSTALLATION')
  and bp.trigger_type = 'APPROVED_OVERTIME_MINUTES_THRESHOLD';

alter table public.bonus_policies
  drop constraint if exists bonus_policies_payroll_2026_canonical_chk;
alter table public.bonus_policies
  add constraint bonus_policies_payroll_2026_canonical_chk
  check (
    trigger_type <> 'APPROVED_OVERTIME_MINUTES_THRESHOLD'
    or (
      threshold_minutes = 120
      and amount = 1000
      and currency = 'CLP'
    )
  );

-- El motor SECURITY DEFINER sigue siendo el único escritor. RR. HH. decide
-- las horas aprobadas, no el monto fijo; SUPER_ADMIN tampoco puede cambiarlo.
drop policy if exists bonus_policies_write_admin on public.bonus_policies;
revoke insert, update, delete on public.bonus_policies from authenticated;

-- Mantiene las defensas de concurrencia y marcación incompleta de la versión
-- anterior, pero elimina el selector binario y cualquier redondeo sobre lo
-- realmente registrado. Una aprobación válida conserva minutos exactos desde
-- 60 hasta el tope; el exceso queda rechazado en una decisión parcial creada
-- por la capa de aplicación.
create or replace function public.validate_overtime_decision()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_candidate            integer;
  v_overtime_policy_id   uuid;
  v_work_date            date;
  v_overtime_type_id     uuid;
  v_group_code           text;
  v_max                  integer;
  v_missing_punch        boolean;
  v_attendance_record_id uuid;
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtextextended(new.overtime_record_id::text, 1));

    if exists (
      select 1
      from public.overtime_decisions
      where overtime_record_id = new.overtime_record_id
        and is_current
    ) then
      raise exception
        'An active overtime decision already exists for this overtime record. Ask ADMIN_RRHH to review and invalidate it before creating a new one.';
    end if;
  end if;

  select
    ovr.candidate_minutes,
    ovr.overtime_policy_id,
    ovr.work_date,
    ovr.overtime_type_id,
    ovr.attendance_record_id
  into
    v_candidate,
    v_overtime_policy_id,
    v_work_date,
    v_overtime_type_id,
    v_attendance_record_id
  from public.overtime_records ovr
  where ovr.id = new.overtime_record_id;

  if v_candidate is null then
    raise exception 'overtime_record % not found', new.overtime_record_id;
  end if;

  -- La única actualización admitida por la tabla es retirar vigencia. Debe
  -- poder hacerse incluso cuando precisamente la regla nueva volvió inválida
  -- la aprobación histórica; el contenido original permanece inmutable.
  if tg_op = 'UPDATE' and old.is_current and not new.is_current then
    return new;
  end if;

  if tg_op = 'INSERT' and new.approved_minutes > 0 then
    perform pg_advisory_xact_lock(hashtextextended(v_attendance_record_id::text, 2));
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

  if new.approved_minutes between 1 and 59 then
    raise exception
      'approved_minutes (%) is below the minimum payable threshold of 60 minutes for overtime_record %',
      new.approved_minutes, new.overtime_record_id;
  end if;

  select eg.code
  into v_group_code
  from public.overtime_policies op
  join public.employee_groups eg on eg.id = op.employee_group_id
  where op.id = v_overtime_policy_id;

  v_max := public.max_approvable_overtime_minutes(
    v_group_code,
    v_work_date,
    v_overtime_type_id
  );

  if v_max is not null and new.approved_minutes > v_max then
    raise exception
      'approved_minutes (%) exceeds the maximum approvable overtime minutes (%) for group % on % (overtime_record %)',
      new.approved_minutes, v_max, v_group_code, v_work_date, new.overtime_record_id;
  end if;

  -- Los campos del selector binario anterior ya no representan una regla
  -- vigente. Solo se conserva la alerta de que el dato real excede el tope.
  new.system_proposed_minutes := null;
  new.requires_manual_review :=
    v_max is not null
    and v_candidate > v_max;

  if new.approved_minutes > 0 then
    select (effective_clock_in is null or effective_clock_out is null)
    into v_missing_punch
    from public.attendance_effective_punches aep
    where aep.attendance_record_id = v_attendance_record_id;

    if coalesce(v_missing_punch, true) then
      raise exception
        'Cannot approve overtime minutes for overtime_record %: the underlying attendance record has an incomplete (missing clock-in or clock-out) punch. Resolve it via an authorized attendance_corrections entry first.',
        new.overtime_record_id;
    end if;
  end if;

  return new;
end;
$$;

-- El bono usa el grupo congelado en overtime_policy_id. La ficha actual del
-- trabajador puede cambiar de área y no debe reescribir una regla histórica.
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
  perform pg_advisory_xact_lock(
    hashtextextended(p_employee_id::text || ':' || p_work_date::text, 0)
  );

  select op.employee_group_id, eg.code
    into v_group_id, v_group_code
  from public.overtime_records ovr
  join public.overtime_policies op on op.id = ovr.overtime_policy_id
  join public.employee_groups eg on eg.id = op.employee_group_id
  where ovr.employee_id = p_employee_id
    and ovr.work_date = p_work_date
    and ovr.is_current
  limit 1;

  select edb.id into v_existing_bonus_id
  from public.employee_daily_bonuses edb
  join public.bonus_policies existing_policy
    on existing_policy.id = edb.bonus_policy_id
  where edb.employee_id = p_employee_id
    and edb.work_date = p_work_date
    and existing_policy.trigger_type = 'APPROVED_OVERTIME_MINUTES_THRESHOLD'
  limit 1;

  if v_group_code is null or v_group_code not in ('PRODUCTION', 'INSTALLATION') then
    if v_existing_bonus_id is not null then
      delete from public.employee_daily_bonuses where id = v_existing_bonus_id;
    end if;
    return;
  end if;

  select exists (
    select 1 from public.reporting_periods rp
    where rp.status = 'CLOSED'
      and p_work_date between rp.period_start and rp.period_end
  ) into v_period_closed;

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
  elsif v_existing_bonus_id is not null then
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
end;
$$;

comment on function public.recompute_employee_daily_bonus(uuid, date) is
  'Recomputa el bono diario fijo de $1.000 desde la decisión vigente y el grupo '
  'histórico congelado en overtime_records.overtime_policy_id; nunca desde la ficha actual.';

revoke all on function public.recompute_employee_daily_bonus(uuid, date) from public;

-- Corrige únicamente resultados aún abiertos que hubieran sido creados cuando
-- el catálogo era mutable. Los períodos cerrados permanecen como evidencia
-- histórica; para cada fila abierta se conserva un evento antes de recomputar
-- desde la decisión vigente con la regla fija.
do $normalize_open_bonus_results$
declare
  v_bonus record;
begin
  for v_bonus in
    select edb.id, edb.employee_id, edb.work_date, edb.amount, edb.currency
    from public.employee_daily_bonuses edb
    join public.bonus_policies bp on bp.id = edb.bonus_policy_id
    where bp.trigger_type = 'APPROVED_OVERTIME_MINUTES_THRESHOLD'
      and (edb.amount <> 1000 or edb.currency <> 'CLP')
      and not exists (
        select 1
        from public.reporting_periods rp
        where rp.status = 'CLOSED'
          and edb.work_date between rp.period_start and rp.period_end
      )
  loop
    delete from public.employee_daily_bonuses where id = v_bonus.id;
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      null,
      'DAILY_BONUS_NORMALIZED_BY_CANONICAL_2026_RULES',
      'employee_daily_bonuses',
      v_bonus.id,
      jsonb_build_object(
        'employee_id', v_bonus.employee_id,
        'work_date', v_bonus.work_date,
        'previous_amount', v_bonus.amount,
        'previous_currency', v_bonus.currency,
        'canonical_amount', 1000,
        'canonical_currency', 'CLP'
      )
    );
    perform public.recompute_employee_daily_bonus(v_bonus.employee_id, v_bonus.work_date);
  end loop;
end;
$normalize_open_bonus_results$;

-- Las decisiones ya cerradas son snapshots históricos y no se reescriben.
-- En períodos abiertos/reabiertos, cualquier aprobación vigente que contradiga
-- clasificación, mínimo o tope canónicos se invalida de forma trazable. Así el
-- caso reaparece pendiente y una persona competente debe decidirlo otra vez;
-- nunca se recorta ni se convierte automáticamente en pago.
with invalid_decisions as (
  select
    od.id,
    od.approved_minutes,
    ovr.work_date,
    eg.code as group_code,
    ot.code as stored_overtime_type,
    expected_ot.code as expected_overtime_type,
    public.max_approvable_overtime_minutes(eg.code, ovr.work_date, ovr.overtime_type_id) as canonical_max
  from public.overtime_decisions od
  join public.overtime_records ovr on ovr.id = od.overtime_record_id
  join public.overtime_policies op on op.id = ovr.overtime_policy_id
  join public.employee_groups eg on eg.id = op.employee_group_id
  join public.overtime_types ot on ot.id = ovr.overtime_type_id
  left join public.overtime_types expected_ot
    on expected_ot.id = public.classify_overtime_type_id(ovr.work_date)
  where od.is_current
    and ovr.is_current
    and od.approved_minutes > 0
    and not exists (
      select 1
      from public.reporting_periods rp
      where rp.status = 'CLOSED'
        and ovr.work_date between rp.period_start and rp.period_end
    )
    and (
      od.approved_minutes < 60
      or ot.id is distinct from public.classify_overtime_type_id(ovr.work_date)
      or (
        public.max_approvable_overtime_minutes(eg.code, ovr.work_date, ovr.overtime_type_id) is not null
        and od.approved_minutes > public.max_approvable_overtime_minutes(eg.code, ovr.work_date, ovr.overtime_type_id)
      )
    )
), invalidated as (
  update public.overtime_decisions od
  set is_current = false
  from invalid_decisions i
  where od.id = i.id
  returning od.id
)
insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
select
  null,
  'OVERTIME_DECISION_INVALIDATED_BY_CANONICAL_2026_RULES',
  'overtime_decisions',
  i.id,
  jsonb_build_object(
    'approved_minutes', i.approved_minutes,
    'work_date', i.work_date,
    'group_code', i.group_code,
    'stored_overtime_type', i.stored_overtime_type,
    'expected_overtime_type', i.expected_overtime_type,
    'canonical_max', i.canonical_max,
    'effect', 'REQUIRES_NEW_HUMAN_DECISION'
  )
from invalid_decisions i
join invalidated x on x.id = i.id;

-- SUPER_ADMIN conserva lectura y auditoría técnica, pero no puede abrir,
-- cerrar ni reabrir un período. Todas las mutaciones de reporting_periods
-- quedan exclusivamente en ADMIN_RRHH.
drop policy if exists reporting_periods_insert_admin on public.reporting_periods;
create policy reporting_periods_insert_admin on public.reporting_periods
  for insert to authenticated
  with check (coalesce(public.has_company_app_role(
    '0a4c0000-0000-0000-0000-000000000001'::uuid,
    'ADMIN_RRHH'
  ), false));

drop policy if exists reporting_periods_update_admin on public.reporting_periods;
create policy reporting_periods_update_admin on public.reporting_periods
  for update to authenticated
  using (coalesce(public.has_company_app_role(
    '0a4c0000-0000-0000-0000-000000000001'::uuid,
    'ADMIN_RRHH'
  ), false))
  with check (
    coalesce(public.has_company_app_role(
      '0a4c0000-0000-0000-0000-000000000001'::uuid,
      'ADMIN_RRHH'
    ), false)
    and (status <> 'CLOSED' or closed_by = auth.uid())
    and (status <> 'REOPENED' or reopened_by = auth.uid())
  );
