-- GESTORA Rendiciones EX-6: conciliación de rendiciones aprobadas.
--
-- expense_report_status ya incluía 'PAID' desde EX-1 (20260901190000), pero
-- ningún RPC transicionaba nunca a ese estado -- expense_dashboard_summary()
-- incluso agrupaba ('APPROVED', 'PAID') en approved_count desde esa misma
-- migración, anticipando este paso. Esta migración es la primera que lo usa
-- de verdad: marcar una rendición APROBADA como pagada, con una referencia de
-- pago o asiento contable y quién/cuándo lo hizo -- nunca ajusta el monto
-- aprobado ni reabre la revisión.

insert into public.permission_definitions (code, module_key, description) values
  ('expenses.reconcile', 'expenses', 'Marcar rendiciones aprobadas como pagadas, con referencia de pago o asiento contable.')
on conflict (code) do nothing;

-- provision_expense_role_permissions() (EX-1) ya otorga cualquier permiso
-- con module_key = 'expenses' a COMPANY_OWNER/HR_ADMIN para toda empresa
-- NUEVA -- este insert solo pone al día a las empresas que ya existían antes
-- de este permiso.
insert into public.company_role_permissions (company_id, role_id, permission_code)
select cr.company_id, cr.id, 'expenses.reconcile'
from public.company_roles cr
where cr.code in ('COMPANY_OWNER', 'HR_ADMIN')
on conflict do nothing;

alter table public.expense_reports
  add column paid_at timestamptz,
  add column paid_by uuid references public.profiles(id),
  add column payment_reference text check (payment_reference is null or char_length(btrim(payment_reference)) between 1 and 160);

alter table public.expense_reports
  add constraint expense_reports_paid_consistency_chk check (
    (status = 'PAID') = (paid_at is not null and paid_by is not null and payment_reference is not null)
  );

comment on column public.expense_reports.paid_at is
  'Cuándo se concilió el reembolso -- se congela junto con paid_by y payment_reference al pasar a PAID vía reconcile_expense_report(), nunca por escritura directa.';
comment on column public.expense_reports.payment_reference is
  'Referencia de pago o asiento contable que respalda la conciliación. Obligatoria y estable: no se vuelve a editar después de conciliar.';

-- reconcile_expense_report(): única forma de llegar a PAID. Solo aplica
-- sobre una rendición ya APROBADA -- no reabre revisión, no ajusta montos,
-- no reemplaza la separación de funciones de decide_expense_report(). El
-- disparador de auditoría existente (record_expense_report_event(), EX-1)
-- ya registra el cambio de status sin trabajo adicional acá.
create or replace function public.reconcile_expense_report(
  p_report_id uuid,
  p_payment_reference text
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
  v_status public.expense_report_status;
  v_reference text := nullif(btrim(p_payment_reference), '');
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_report_id is null then raise exception 'report_id es obligatorio.' using errcode = '22004'; end if;
  if v_reference is null then raise exception 'Debes indicar una referencia de pago o asiento contable.' using errcode = '23514'; end if;

  select er.company_id, er.status into v_company_id, v_status
  from public.expense_reports er where er.id = p_report_id for update;

  if not found then raise exception 'Rendición inexistente.' using errcode = '23503'; end if;
  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id)
     or (not public.has_company_permission(v_company_id, 'expenses.reconcile') and not public.has_company_permission(v_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite conciliar rendiciones.' using errcode = '42501';
  end if;
  if v_status <> 'APPROVED' then
    raise exception 'Solo se puede conciliar una rendición aprobada.' using errcode = '23514';
  end if;

  update public.expense_reports er
  set status = 'PAID',
      paid_at = pg_catalog.clock_timestamp(),
      paid_by = v_actor_id,
      payment_reference = v_reference
  where er.company_id = v_company_id and er.id = p_report_id;
end;
$$;

comment on function public.reconcile_expense_report(uuid, text) is
  'Marca una rendición APROBADA como pagada/conciliada con referencia de pago obligatoria. Única vía hacia el estado PAID -- el navegador nunca puede escribir paid_at/paid_by/payment_reference directamente.';

revoke all on function public.reconcile_expense_report(uuid, text) from public, anon;
grant execute on function public.reconcile_expense_report(uuid, text) to authenticated;
