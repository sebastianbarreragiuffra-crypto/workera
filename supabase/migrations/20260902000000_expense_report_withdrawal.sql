-- GESTORA Rendiciones EX-5: retiro de rendiciones enviadas.
--
-- Hasta ahora, una vez SUBMITTED, la única forma de volver a DRAFT era que
-- un aprobador la devolviera (decide_expense_report(..., 'RETURNED', ...)).
-- Eso obliga a esperar a otra persona incluso para un error obvio que el
-- propio rendidor ya notó (monto mal tipeado, comprobante equivocado). Este
-- RPC deja que el mismo rendidor (o expenses.manage) la retire directamente
-- mientras siga pendiente de revisión -- nunca después de que alguien ya
-- decidió (APPROVED/REJECTED son terminales, y RETURNED ya vuelve a DRAFT
-- por su propio camino).
create or replace function public.withdraw_expense_report(p_report_id uuid)
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
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_report_id is null then raise exception 'report_id es obligatorio.' using errcode = '22004'; end if;

  select er.company_id, er.submitted_by, er.status
    into v_company_id, v_submitted_by, v_status
  from public.expense_reports er where er.id = p_report_id for update;

  if not found then raise exception 'Rendición inexistente.' using errcode = '23503'; end if;
  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id) then
    raise exception 'Rendiciones no está habilitado para esta membresía.' using errcode = '42501';
  end if;
  if v_submitted_by <> v_actor_id and not public.has_company_permission(v_company_id, 'expenses.manage') then
    raise exception 'No puedes retirar una rendición de otra persona.' using errcode = '42501';
  end if;
  if v_status not in ('SUBMITTED', 'IN_REVIEW') then
    raise exception 'Solo se puede retirar una rendición pendiente de revisión.' using errcode = '23514';
  end if;

  -- El mismo lock de fila que ya usan submit/decide serializa esto contra
  -- una decisión concurrente: si un aprobador ya la resolvió (o el propio
  -- rendidor ya la retiró) antes de que este UPDATE tome el lock, el
  -- chequeo de v_status de arriba ya lo habría rechazado.
  update public.expense_reports er
  set status = 'DRAFT', submitted_at = null, resolved_at = null
  where er.company_id = v_company_id and er.id = p_report_id;
end;
$$;

comment on function public.withdraw_expense_report(uuid) is
  'El propio rendidor (o expenses.manage) retira su rendición pendiente de '
  'revisión y la deja en DRAFT para corregirla, sin esperar a que un '
  'aprobador la devuelva. Nunca alcanza a APPROVED/REJECTED (terminales).';

revoke all on function public.withdraw_expense_report(uuid) from public, anon;
grant execute on function public.withdraw_expense_report(uuid) to authenticated;
