-- GESTORA Rendiciones EX-5: primer uso real de expense_policies.rules --
-- monto máximo por categoría. Hasta ahora `rules` era un objeto decorativo
-- que nadie leía (ver 20260901191000_expenses_operational_workflow.sql,
-- provision_expense_defaults(): receipt_required_from/duplicate_detection/
-- approval_mode se sembraban pero ningún código los consultaba).
--
-- Convención nueva: rules.categoryLimits = { "<category_id>": <monto> }.
-- Si un gasto de esa categoría supera el límite, el ENVÍO se bloquea --
-- nunca se ajusta el monto ni se salta la validación en silencio. Sin
-- política activa (policy_id null en la rendición) no hay límite alguno,
-- así que esto es retrocompatible con toda rendición ya creada.
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

  update public.expense_reports er
  set status = 'SUBMITTED', submitted_at = pg_catalog.clock_timestamp(),
      resolved_at = null, review_round = er.review_round + 1
  where er.company_id = v_company_id and er.id = p_report_id;
end;
$$;

comment on function public.submit_expense_report(uuid) is
  'Congela el total, exige comprobantes obligatorios y valida que ningún '
  'gasto supere el límite de su categoría según la política activa '
  '(rules.categoryLimits) antes de abrir una nueva ronda de revisión.';
