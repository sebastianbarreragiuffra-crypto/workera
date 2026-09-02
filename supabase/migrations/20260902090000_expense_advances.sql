-- GESTORA Rendiciones EX-7: anticipos y fondos por rendir.
--
-- Hasta ahora una rendición siempre nace de un gasto ya pagado por la
-- persona con su propia plata (EX-1 a EX-6). Esta migración agrega el otro
-- flujo: la empresa entrega dinero POR ADELANTADO a alguien (un anticipo o
-- fondo por rendir) y esa persona, más tarde, rinde contra ese anticipo en
-- vez de esperar un reembolso por algo que ya pagó.
--
-- Alcance deliberadamente acotado (primera pasada de EX-7, misma filosofía
-- de recortes chicos que MT-3B): un anticipo se otorga, se vincula
-- opcionalmente a una o más rendiciones en borrador de su misma persona y
-- moneda, y finanzas lo cierra manualmente (`settle_expense_advance`) cuando
-- da por saldado el ciclo. NO hay una transición automática de estado ni un
-- cálculo de saldo forzado por trigger: cuánto cuadra el anticipo contra lo
-- rendido es información que la UI muestra (suma de expense_reports.
-- advance_id vinculadas, ya legible con la RLS existente), y cerrarlo con
-- una diferencia pendiente (para devolver en efectivo, por ejemplo) es una
-- decisión de finanzas, no algo que la base de datos deba bloquear.

create type public.expense_advance_status as enum ('PENDING', 'SETTLED', 'CANCELLED');

create table public.expense_advances (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  recipient_id   uuid not null references public.profiles(id),
  amount         numeric(16,2) not null check (amount > 0),
  currency_code  text not null default 'CLP' check (currency_code ~ '^[A-Z]{3}$'),
  purpose        text not null check (char_length(btrim(purpose)) between 2 and 240),
  status         public.expense_advance_status not null default 'PENDING',
  granted_by     uuid not null references public.profiles(id),
  granted_at     timestamptz not null default now(),
  settled_at     timestamptz,
  settled_by     uuid references public.profiles(id),
  cancelled_at   timestamptz,
  cancelled_by   uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  unique (company_id, id),
  constraint expense_advances_settled_consistency_chk check (
    (status = 'SETTLED') = (settled_at is not null and settled_by is not null)
  ),
  constraint expense_advances_cancelled_consistency_chk check (
    (status = 'CANCELLED') = (cancelled_at is not null and cancelled_by is not null)
  )
);

create index expense_advances_company_status_idx on public.expense_advances(company_id, status, granted_at desc);
create index expense_advances_recipient_idx on public.expense_advances(company_id, recipient_id, granted_at desc);

comment on table public.expense_advances is
  'Anticipos/fondos por rendir (EX-7). Toda escritura pasa por '
  'grant_expense_advance()/link_expense_report_to_advance()/'
  'settle_expense_advance()/cancel_expense_advance() -- authenticated no '
  'tiene INSERT/UPDATE/DELETE directo, mismo patrón que paid_at/paid_by/'
  'payment_reference en EX-6.';

-- Una rendición puede (opcionalmente) rendir contra un anticipo propio, en
-- vez de -- o además de -- pedir un reembolso por plata ya puesta por la
-- persona. Composite FK contra (company_id, id) para que nunca pueda
-- vincularse un anticipo de otra empresa, mismo patrón que policy_id/
-- organization_unit_id en la tabla original (20260901190000).
alter table public.expense_reports
  add column advance_id uuid;
alter table public.expense_reports
  add constraint expense_reports_advance_company_fk
    foreign key (company_id, advance_id) references public.expense_advances(company_id, id);
create index expense_reports_advance_idx
  on public.expense_reports(company_id, advance_id)
  where advance_id is not null;

comment on column public.expense_reports.advance_id is
  'Anticipo contra el que rinde esta rendición, si corresponde. Solo se '
  'escribe vía link_expense_report_to_advance() -- no está en el GRANT UPDATE '
  'de authenticated sobre expense_reports (20260901190000), así que un '
  'UPDATE directo del cliente no puede tocarlo aunque pase la RLS de '
  'expense_reports_update_draft.';

-- ---------------------------------------------------------------------------
alter table public.expense_advances enable row level security;

create policy expense_advances_read on public.expense_advances for select to authenticated
  using (
    public.company_has_module(company_id, 'expenses')
    and public.is_active_company_member(company_id)
    and (
      recipient_id = auth.uid()
      or public.has_company_permission(company_id, 'expenses.read')
      or public.has_company_permission(company_id, 'expenses.approve')
      or public.has_company_permission(company_id, 'expenses.reconcile')
      or public.has_company_permission(company_id, 'expenses.manage')
    )
  );

grant select on public.expense_advances to authenticated;
revoke all on public.expense_advances from anon;

-- ---------------------------------------------------------------------------
-- grant_expense_advance(): única forma de crear un anticipo. Reutiliza los
-- permisos 'expenses.reconcile'/'expenses.manage' ya existentes desde EX-6
-- en vez de crear un permission_definitions nuevo -- otorgar plata por
-- adelantado es la misma función de finanzas que conciliar un pago.
create or replace function public.grant_expense_advance(
  p_company_id uuid,
  p_recipient_id uuid,
  p_amount numeric,
  p_currency_code text,
  p_purpose text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_advance_id uuid;
  v_purpose text := nullif(btrim(p_purpose), '');
  v_currency text := upper(coalesce(p_currency_code, ''));
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_company_id is null or p_recipient_id is null then raise exception 'company_id y recipient_id son obligatorios.' using errcode = '22004'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El monto del anticipo debe ser mayor a cero.' using errcode = '23514'; end if;
  if v_purpose is null then raise exception 'Debes indicar el motivo del anticipo.' using errcode = '23514'; end if;
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'Moneda inválida.' using errcode = '23514'; end if;

  if not public.company_has_module(p_company_id, 'expenses') or not public.is_active_company_member(p_company_id)
     or (not public.has_company_permission(p_company_id, 'expenses.reconcile') and not public.has_company_permission(p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite otorgar anticipos.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.company_memberships cm
    where cm.user_id = p_recipient_id and cm.company_id = p_company_id and cm.active
  ) then
    raise exception 'La persona destinataria no es miembro activo de esta empresa.' using errcode = '23503';
  end if;

  insert into public.expense_advances (company_id, recipient_id, amount, currency_code, purpose, granted_by)
  values (p_company_id, p_recipient_id, p_amount, v_currency, v_purpose, v_actor_id)
  returning id into v_advance_id;

  insert into public.expense_audit_events (company_id, actor_id, event_type, metadata)
  values (p_company_id, v_actor_id, 'expense_advance.granted',
    jsonb_build_object('advance_id', v_advance_id, 'recipient_id', p_recipient_id, 'amount', p_amount, 'currency_code', v_currency));

  return v_advance_id;
end;
$$;

comment on function public.grant_expense_advance(uuid, uuid, numeric, text, text) is
  'Única forma de crear un anticipo/fondo por rendir -- exige expenses.reconcile '
  'o expenses.manage y que el destinatario sea miembro activo de la empresa.';

revoke all on function public.grant_expense_advance(uuid, uuid, numeric, text, text) from public, anon;
grant execute on function public.grant_expense_advance(uuid, uuid, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- link_expense_report_to_advance(): vincula (p_advance_id no nulo) o
-- desvincula (p_advance_id null) una rendición EN BORRADOR a un anticipo
-- PROPIO, pendiente, de la misma moneda -- única vía de escritura de
-- expense_reports.advance_id.
create or replace function public.link_expense_report_to_advance(
  p_report_id uuid,
  p_advance_id uuid
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
  v_submitted_by uuid;
  v_report_currency text;
  v_advance_company uuid;
  v_advance_recipient uuid;
  v_advance_currency text;
  v_advance_status public.expense_advance_status;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_report_id is null then raise exception 'report_id es obligatorio.' using errcode = '22004'; end if;

  select er.company_id, er.status, er.submitted_by, er.currency_code
    into v_company_id, v_status, v_submitted_by, v_report_currency
  from public.expense_reports er where er.id = p_report_id for update;
  if not found then raise exception 'Rendición inexistente.' using errcode = '23503'; end if;
  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id) then
    raise exception 'Rendiciones no está habilitado para esta membresía.' using errcode = '42501';
  end if;

  if v_submitted_by <> v_actor_id and not public.has_company_permission(v_company_id, 'expenses.manage') then
    raise exception 'No puedes modificar una rendición de otra persona.' using errcode = '42501';
  end if;

  if p_advance_id is null then
    -- Desvincular se permite en borrador (arrepentirse antes de enviar) y en
    -- estados terminales sin pago real (REJECTED/CANCELLED) -- de lo
    -- contrario un anticipo vinculado a una rendición rechazada quedaría
    -- atrapado para siempre: link_expense_report_to_advance() sería la única
    -- forma de soltarlo, pero exigir DRAFT se lo impediría, y
    -- cancel_expense_advance() ya rechaza cancelar mientras exista CUALQUIER
    -- rendición vinculada, sin importar su estado.
    if v_status not in ('DRAFT', 'REJECTED', 'CANCELLED') then
      raise exception 'Solo se puede desvincular un anticipo mientras la rendición está en borrador, rechazada o cancelada.' using errcode = '23514';
    end if;
    update public.expense_reports set advance_id = null where company_id = v_company_id and id = p_report_id;
    insert into public.expense_audit_events (company_id, report_id, actor_id, event_type, metadata)
    values (v_company_id, p_report_id, v_actor_id, 'expense_advance.unlinked', '{}'::jsonb);
    return;
  end if;

  if v_status <> 'DRAFT' then
    raise exception 'Solo se puede vincular un anticipo mientras la rendición está en borrador.' using errcode = '23514';
  end if;

  select ea.company_id, ea.recipient_id, ea.currency_code, ea.status
    into v_advance_company, v_advance_recipient, v_advance_currency, v_advance_status
  from public.expense_advances ea where ea.id = p_advance_id for update;
  if not found then raise exception 'Anticipo inexistente.' using errcode = '23503'; end if;

  if v_advance_company <> v_company_id then
    raise exception 'El anticipo pertenece a otra empresa.' using errcode = '23503';
  end if;
  if v_advance_recipient <> v_submitted_by then
    raise exception 'Solo puedes vincular un anticipo otorgado a la persona que envía esta rendición.' using errcode = '42501';
  end if;
  if v_advance_status <> 'PENDING' then
    raise exception 'Este anticipo ya no está pendiente de rendir.' using errcode = '23514';
  end if;
  if v_advance_currency <> v_report_currency then
    raise exception 'La moneda de la rendición debe coincidir con la del anticipo.' using errcode = '23514';
  end if;

  update public.expense_reports set advance_id = p_advance_id where company_id = v_company_id and id = p_report_id;
  insert into public.expense_audit_events (company_id, report_id, actor_id, event_type, metadata)
  values (v_company_id, p_report_id, v_actor_id, 'expense_advance.linked', jsonb_build_object('advance_id', p_advance_id));
end;
$$;

comment on function public.link_expense_report_to_advance(uuid, uuid) is
  'Vincula (o desvincula, con p_advance_id null) una rendición en borrador a '
  'un anticipo propio pendiente, en la misma moneda.';

revoke all on function public.link_expense_report_to_advance(uuid, uuid) from public, anon;
grant execute on function public.link_expense_report_to_advance(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- settle_expense_advance(): cierre manual de finanzas. No exige que la suma
-- de rendiciones vinculadas cuadre exacto con el monto -- una diferencia se
-- puede resolver fuera de la app (ej. devolución en efectivo del saldo no
-- rendido), y la base de datos no debe bloquear esa decisión operativa.
create or replace function public.settle_expense_advance(p_advance_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_status public.expense_advance_status;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_advance_id is null then raise exception 'advance_id es obligatorio.' using errcode = '22004'; end if;

  select ea.company_id, ea.status into v_company_id, v_status
  from public.expense_advances ea where ea.id = p_advance_id for update;
  if not found then raise exception 'Anticipo inexistente.' using errcode = '23503'; end if;

  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id)
     or (not public.has_company_permission(v_company_id, 'expenses.reconcile') and not public.has_company_permission(v_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite cerrar anticipos.' using errcode = '42501';
  end if;
  if v_status <> 'PENDING' then
    raise exception 'Solo se puede cerrar un anticipo pendiente.' using errcode = '23514';
  end if;

  update public.expense_advances
  set status = 'SETTLED', settled_at = pg_catalog.clock_timestamp(), settled_by = v_actor_id
  where company_id = v_company_id and id = p_advance_id;

  insert into public.expense_audit_events (company_id, actor_id, event_type, metadata)
  values (v_company_id, v_actor_id, 'expense_advance.settled', jsonb_build_object('advance_id', p_advance_id));
end;
$$;

comment on function public.settle_expense_advance(uuid) is
  'Cierra un anticipo pendiente como saldado -- decisión manual de finanzas, '
  'no exige que el saldo cuadre exacto.';

revoke all on function public.settle_expense_advance(uuid) from public, anon;
grant execute on function public.settle_expense_advance(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- cancel_expense_advance(): solo si todavía no tiene ninguna rendición
-- vinculada -- una vez que existe al menos una, la única salida es
-- settle_expense_advance() (cancelar borraría el rastro de plata ya en uso).
create or replace function public.cancel_expense_advance(p_advance_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_status public.expense_advance_status;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_advance_id is null then raise exception 'advance_id es obligatorio.' using errcode = '22004'; end if;

  select ea.company_id, ea.status into v_company_id, v_status
  from public.expense_advances ea where ea.id = p_advance_id for update;
  if not found then raise exception 'Anticipo inexistente.' using errcode = '23503'; end if;

  if not public.company_has_module(v_company_id, 'expenses') or not public.is_active_company_member(v_company_id)
     or (not public.has_company_permission(v_company_id, 'expenses.reconcile') and not public.has_company_permission(v_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite cancelar anticipos.' using errcode = '42501';
  end if;
  if v_status <> 'PENDING' then
    raise exception 'Solo se puede cancelar un anticipo pendiente.' using errcode = '23514';
  end if;
  -- Un reporte que quedó vinculado pero se desvinculó después (rechazado o
  -- cancelado, ver link_expense_report_to_advance) ya no cuenta acá: solo
  -- expense_reports.advance_id ACTUAL bloquea la cancelación, no el
  -- historial de auditoría.
  if exists (select 1 from public.expense_reports er where er.advance_id = p_advance_id) then
    raise exception 'Este anticipo ya tiene rendiciones vinculadas -- ciérralo en vez de cancelarlo.' using errcode = '23514';
  end if;

  update public.expense_advances
  set status = 'CANCELLED', cancelled_at = pg_catalog.clock_timestamp(), cancelled_by = v_actor_id
  where company_id = v_company_id and id = p_advance_id;

  insert into public.expense_audit_events (company_id, actor_id, event_type, metadata)
  values (v_company_id, v_actor_id, 'expense_advance.cancelled', jsonb_build_object('advance_id', p_advance_id));
end;
$$;

comment on function public.cancel_expense_advance(uuid) is
  'Cancela un anticipo pendiente SIN rendiciones vinculadas todavía.';

revoke all on function public.cancel_expense_advance(uuid) from public, anon;
grant execute on function public.cancel_expense_advance(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- submit_expense_report() (última versión: 20260902020000) redefinida una
-- vez más: currency_code sigue siendo una columna directamente editable por
-- el submitter mientras el reporte está en DRAFT (GRANT de
-- 20260901190000), así que nada impedía cambiarla DESPUÉS de vincular un
-- anticipo, dejando advance_id apuntando a un anticipo en otra moneda. Se
-- agrega el mismo chequeo de moneda que link_expense_report_to_advance() ya
-- hace al vincular, pero evaluado también al momento de enviar -- el punto
-- que de verdad importa, porque es la última oportunidad de bloquearlo antes
-- de que el anticipo quede comprometido contra una rendición incompatible.
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
  v_currency_code text;
  v_advance_id uuid;
  v_second_approver_threshold numeric;
  v_required_steps integer;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_report_id is null then raise exception 'report_id es obligatorio.' using errcode = '22004'; end if;

  select er.company_id, er.submitted_by, er.status, er.total_amount, er.policy_id, er.currency_code, er.advance_id
    into v_company_id, v_submitted_by, v_status, v_total, v_policy_id, v_currency_code, v_advance_id
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
      and ei.currency_code <> v_currency_code
  ) then raise exception 'Todos los gastos deben usar la moneda de la rendición.' using errcode = '23514'; end if;
  if v_advance_id is not null and exists (
    select 1 from public.expense_advances ea where ea.id = v_advance_id and ea.currency_code <> v_currency_code
  ) then
    raise exception 'La moneda de la rendición ya no coincide con la del anticipo vinculado -- corrige la moneda o desvincula el anticipo antes de enviar.' using errcode = '23514';
  end if;
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
  'Envía una rendición en borrador a revisión -- valida ítems, comprobantes, '
  'límites por categoría y (EX-7) que la moneda siga coincidiendo con la del '
  'anticipo vinculado, si corresponde. Congela required_approval_steps.';

revoke all on function public.submit_expense_report(uuid) from public, anon;
grant execute on function public.submit_expense_report(uuid) to authenticated;
