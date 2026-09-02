-- GESTORA Rendiciones EX-5: cadenas de aprobación multi-paso con
-- separación real de funciones, y snapshot de los pasos requeridos al
-- enviar.
--
-- Disparador (definido junto con el encargo): el MONTO TOTAL de la
-- rendición. Sobre expense_policies.rules.secondApproverThreshold, se
-- necesita un segundo aprobador -- distinto del primero, nunca la misma
-- persona resolviendo dos pasos de la misma ronda, aunque tenga permiso
-- formal para ambos (el mismo criterio que ya impedía la autoaprobación).
--
-- Snapshot: expense_reports.required_approval_steps se calcula UNA VEZ en
-- submit_expense_report() con el umbral vigente en ese momento, nunca se
-- vuelve a evaluar en decide_expense_report(). Si alguien cambia el umbral
-- mientras la rendición está pendiente, no le cambia las reglas a mitad de
-- camino -- exactamente el motivo por el que existe esta columna en vez de
-- leer rules en vivo cada vez que se decide un paso.

alter table public.expense_reports
  add column required_approval_steps integer not null default 1
    check (required_approval_steps between 1 and 2);

comment on column public.expense_reports.required_approval_steps is
  'Snapshot tomado por submit_expense_report() según el umbral vigente en '
  'ese momento (rules.secondApproverThreshold). decide_expense_report() '
  'siempre lee este valor, nunca vuelve a consultar la política en vivo.';

-- step_number pasaba a representar "la ronda" (siempre 1 decisión por
-- ronda). Ahora representa el paso DENTRO de la ronda, así que necesita su
-- propia columna para el número de ronda -- se rellena con el valor
-- anterior de step_number para las filas ya existentes (todas eran de un
-- solo paso, así que ronda y paso coincidían).
alter table public.expense_approval_decisions add column review_round integer;
update public.expense_approval_decisions set review_round = step_number where review_round is null;
alter table public.expense_approval_decisions alter column review_round set not null;
alter table public.expense_approval_decisions add constraint expense_approval_decisions_review_round_chk check (review_round > 0);

-- La unique original (company_id, report_id, step_number) ya no alcanza:
-- dos rondas distintas pueden compartir el mismo step_number (ambas
-- empiezan en 1). Se busca por columnas en vez de adivinar el nombre
-- autogenerado, para no depender de un nombre exacto de constraint.
do $$
declare
  v_constraint_name text;
begin
  select con.conname into v_constraint_name
  from pg_constraint con
  where con.conrelid = 'public.expense_approval_decisions'::regclass
    and con.contype = 'u'
    and (
      select array_agg(pa.attname::text order by pa.attname)
      from unnest(con.conkey) as k(attnum)
      join pg_attribute pa on pa.attrelid = con.conrelid and pa.attnum = k.attnum
    ) = array['company_id', 'report_id', 'step_number']::text[]
  limit 1;

  if v_constraint_name is not null then
    execute format('alter table public.expense_approval_decisions drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.expense_approval_decisions
  add constraint expense_approval_decisions_round_step_key unique (company_id, report_id, review_round, step_number);

comment on column public.expense_approval_decisions.review_round is
  'Ronda de envío (= expense_reports.review_round en el momento de la '
  'decisión). step_number es el paso DENTRO de esa ronda (1, 2...), nunca '
  'la ronda misma -- eso era lo que representaba antes de esta migración.';

-- decide_expense_report(): ahora resuelve el próximo paso pendiente de la
-- ronda actual (no siempre "el" paso), exige un aprobador distinto para
-- cada paso de la misma ronda, y solo aprueba definitivamente cuando se
-- completan TODOS los pasos requeridos según el snapshot.
create or replace function public.decide_expense_report(
  p_report_id uuid,
  p_decision public.expense_approval_decision,
  p_comment text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_submitted_by uuid;
  v_status public.expense_report_status;
  v_review_round integer;
  v_required_steps integer;
  v_next_step integer;
  v_comment text := nullif(btrim(p_comment), '');
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_report_id is null or p_decision is null then raise exception 'report_id y decision son obligatorios.' using errcode = '22004'; end if;

  select er.company_id, er.submitted_by, er.status, er.review_round, er.required_approval_steps
    into v_company_id, v_submitted_by, v_status, v_review_round, v_required_steps
  from public.expense_reports er where er.id = p_report_id for update;

  if not found then raise exception 'Rendición inexistente.' using errcode = '23503'; end if;
  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id)
     or (not public.has_company_permission(v_company_id, 'expenses.approve') and not public.has_company_permission(v_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite decidir esta rendición.' using errcode = '42501';
  end if;
  if v_submitted_by = v_actor_id then
    raise exception 'No puedes aprobar ni rechazar tu propia rendición.' using errcode = '42501';
  end if;
  if v_status not in ('SUBMITTED', 'IN_REVIEW') then
    raise exception 'La rendición no está pendiente de revisión.' using errcode = '23514';
  end if;
  if p_decision in ('REJECTED', 'RETURNED') and v_comment is null then
    raise exception 'Debes explicar el rechazo o la devolución.' using errcode = '23514';
  end if;

  select coalesce(max(step_number), 0) + 1 into v_next_step
  from public.expense_approval_decisions
  where company_id = v_company_id and report_id = p_report_id and review_round = v_review_round;

  -- Separación real de funciones: nadie resuelve dos pasos de la misma
  -- ronda, aunque su rol tenga permiso formal para ambos (igual que ya
  -- pasaba con la autoaprobación -- el permiso nunca alcanza para saltarse
  -- esto).
  if exists (
    select 1 from public.expense_approval_decisions
    where company_id = v_company_id and report_id = p_report_id
      and review_round = v_review_round and decided_by = v_actor_id
  ) then
    raise exception 'Ya registraste una decisión para esta rendición en esta ronda; otra persona debe resolver el siguiente paso.' using errcode = '42501';
  end if;

  insert into public.expense_approval_decisions (
    company_id, report_id, review_round, step_number, decided_by, decision, comment
  ) values (v_company_id, p_report_id, v_review_round, v_next_step, v_actor_id, p_decision, v_comment);

  if p_decision = 'REJECTED' then
    update public.expense_reports er
    set status = 'REJECTED', resolved_at = pg_catalog.clock_timestamp()
    where er.company_id = v_company_id and er.id = p_report_id;
  elsif p_decision = 'RETURNED' then
    update public.expense_reports er
    set status = 'DRAFT', submitted_at = null, resolved_at = null
    where er.company_id = v_company_id and er.id = p_report_id;
  elsif v_next_step >= v_required_steps then
    update public.expense_reports er
    set status = 'APPROVED', resolved_at = pg_catalog.clock_timestamp()
    where er.company_id = v_company_id and er.id = p_report_id;
  else
    -- Falta al menos un paso más: queda visiblemente IN_REVIEW en vez de
    -- volver a SUBMITTED, para que se note que ya hubo una aprobación.
    update public.expense_reports er
    set status = 'IN_REVIEW'
    where er.company_id = v_company_id and er.id = p_report_id;
  end if;
end;
$$;

comment on function public.decide_expense_report(uuid, public.expense_approval_decision, text) is
  'Resuelve el próximo paso pendiente de la ronda actual. Exige un '
  'aprobador distinto por paso (nunca la misma persona dos veces en la '
  'misma ronda) y solo aprueba en definitiva al completar '
  'required_approval_steps -- el snapshot tomado al enviar, nunca una '
  'relectura en vivo de la política.';

-- submit_expense_report(): toma el snapshot de pasos requeridos según el
-- umbral vigente de la política activa. Sin umbral configurado
-- (secondApproverThreshold ausente) o sin política activa, siempre 1 paso
-- -- retrocompatible con toda rendición y toda empresa que no configuró
-- esto todavía.
create or replace function public.submit_expense_report(p_report_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_submitted_by uuid;
  v_status public.expense_report_status;
  v_total numeric(16,2);
  v_item_count integer;
  v_policy_id uuid;
  v_second_approver_threshold numeric;
  v_required_steps integer;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_report_id is null then raise exception 'report_id es obligatorio.' using errcode = '22004'; end if;

  select er.company_id, er.submitted_by, er.status, er.total_amount, er.policy_id
    into v_company_id, v_submitted_by, v_status, v_total, v_policy_id
  from public.expense_reports er where er.id = p_report_id for update;

  if not found then raise exception 'Rendición inexistente.' using errcode = '23503'; end if;
  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id) then
    raise exception 'Rendiciones no está habilitado para esta membresía.' using errcode = '42501';
  end if;
  if v_submitted_by <> v_actor_id and not public.has_company_permission(v_company_id, 'expenses.manage') then
    raise exception 'No puedes enviar una rendición de otra persona.' using errcode = '42501';
  end if;
  if not public.has_company_permission(v_company_id, 'expenses.submit') and not public.has_company_permission(v_company_id, 'expenses.manage') then
    raise exception 'Tu rol no permite enviar rendiciones.' using errcode = '42501';
  end if;
  if v_status <> 'DRAFT' then raise exception 'Solo se puede enviar una rendición en borrador.' using errcode = '23514'; end if;

  select count(*)::integer into v_item_count from public.expense_items ei
  where ei.company_id = v_company_id and ei.report_id = p_report_id;
  if v_item_count = 0 or v_total <= 0 then
    raise exception 'Agrega al menos un gasto con monto mayor a cero antes de enviar.' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.expense_items ei
    where ei.company_id = v_company_id and ei.report_id = p_report_id
      and ei.currency_code <> (select er.currency_code from public.expense_reports er where er.id = p_report_id)
  ) then raise exception 'Todos los gastos deben usar la moneda de la rendición.' using errcode = '23514'; end if;
  if exists (
    select 1
    from public.expense_items ei
    join public.expense_categories ec on ec.company_id = ei.company_id and ec.id = ei.category_id
    where ei.company_id = v_company_id and ei.report_id = p_report_id
      and ec.requires_receipt
      and not exists (
        select 1 from public.expense_receipts r
        where r.company_id = ei.company_id and r.item_id = ei.id and r.is_current
      )
  ) then raise exception 'Adjunta los comprobantes obligatorios antes de enviar.' using errcode = '23514'; end if;
  if exists (
    select 1
    from public.expense_items ei
    join public.expense_policies ep on ep.company_id = ei.company_id and ep.id = v_policy_id
    where ei.company_id = v_company_id and ei.report_id = p_report_id
      and ei.category_id is not null
      and (ep.rules -> 'categoryLimits' ->> ei.category_id::text) is not null
      and ei.total_amount > (ep.rules -> 'categoryLimits' ->> ei.category_id::text)::numeric
  ) then
    raise exception 'Un gasto supera el monto máximo permitido para su categoría según la política vigente.' using errcode = '23514';
  end if;

  select (ep.rules ->> 'secondApproverThreshold')::numeric into v_second_approver_threshold
  from public.expense_policies ep
  where ep.company_id = v_company_id and ep.id = v_policy_id;

  v_required_steps := case
    when v_second_approver_threshold is not null and v_total > v_second_approver_threshold then 2
    else 1
  end;

  update public.expense_reports er
  set status = 'SUBMITTED', submitted_at = pg_catalog.clock_timestamp(),
      resolved_at = null, review_round = er.review_round + 1,
      required_approval_steps = v_required_steps
  where er.company_id = v_company_id and er.id = p_report_id;
end;
$$;

comment on function public.submit_expense_report(uuid) is
  'Congela el total, exige comprobantes obligatorios, valida límites por '
  'categoría, y toma el snapshot de pasos de aprobación requeridos '
  '(required_approval_steps) según el umbral vigente antes de abrir una '
  'nueva ronda de revisión.';
