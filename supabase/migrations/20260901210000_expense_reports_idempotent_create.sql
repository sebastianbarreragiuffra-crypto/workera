-- GESTORA Rendiciones: idempotencia al crear un borrador. Un doble clic o un
-- reintento de red repitiendo la misma request (mismo client_request_id)
-- debe devolver el borrador ya creado, nunca uno duplicado. No se agrega una
-- restricción de "un solo borrador por persona" -- alguien puede tener
-- varios viajes o propósitos legítimos a la vez; el problema real es
-- repetir exactamente el mismo intento, no tener varios borradores.

alter table public.expense_reports
  add column client_request_id uuid;

-- Solo exige unicidad cuando el cliente sí manda un client_request_id -- las
-- filas creadas antes de esta migración (o por cualquier vía que no lo use)
-- quedan con NULL y nunca colisionan entre sí.
create unique index expense_reports_idempotency_key_idx
  on public.expense_reports (company_id, submitted_by, client_request_id)
  where client_request_id is not null;

comment on column public.expense_reports.client_request_id is
  'UUID generado por el formulario al crear el borrador -- permite que un '
  'doble clic o un reintento de red con la misma request devuelva la '
  'rendición ya creada en vez de duplicarla. NULL en filas creadas antes de '
  'esta migración o fuera de create_expense_report().';

-- Reemplaza el INSERT directo de la Server Action: la idempotencia real
-- (devolver la fila existente en vez de fallar o duplicar) no se puede
-- expresar solo con una policy de RLS, necesita esta lógica.
create or replace function public.create_expense_report(
  p_company_id uuid,
  p_title text,
  p_purpose text,
  p_currency_code text,
  p_client_request_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_existing_id uuid;
  v_policy_id uuid;
  v_report_id uuid;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_client_request_id is null then raise exception 'client_request_id es obligatorio.' using errcode = '22004'; end if;
  if p_title is null or char_length(btrim(p_title)) not between 2 and 160 then
    raise exception 'El título debe tener entre 2 y 160 caracteres.' using errcode = '23514';
  end if;
  if p_currency_code !~ '^[A-Z]{3}$' then
    raise exception 'Moneda inválida.' using errcode = '23514';
  end if;
  if not public.company_has_module(p_company_id, 'expenses') or not public.is_active_company_member(p_company_id)
     or (not public.has_company_permission(p_company_id, 'expenses.submit') and not public.has_company_permission(p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite crear rendiciones en esta empresa.' using errcode = '42501';
  end if;

  -- Camino feliz de la idempotencia: ya existe una rendición de este mismo
  -- request -- se devuelve tal cual, sin tocarla ni crear una nueva.
  select id into v_existing_id
  from public.expense_reports
  where company_id = p_company_id and submitted_by = v_actor_id and client_request_id = p_client_request_id;
  if v_existing_id is not null then
    return v_existing_id;
  end if;

  select id into v_policy_id
  from public.expense_policies
  where company_id = p_company_id and active
  order by version desc
  limit 1;

  begin
    insert into public.expense_reports (company_id, submitted_by, policy_id, title, purpose, currency_code, client_request_id)
    values (
      p_company_id, v_actor_id, v_policy_id, btrim(p_title),
      nullif(btrim(coalesce(p_purpose, '')), ''), p_currency_code, p_client_request_id
    )
    returning id into v_report_id;
  exception when unique_violation then
    -- Dos requests concurrentes con el mismo client_request_id (doble clic
    -- real, no un reintento secuencial): el índice único ya lo resolvió,
    -- solo falta devolver la fila que ganó la carrera.
    select id into v_report_id
    from public.expense_reports
    where company_id = p_company_id and submitted_by = v_actor_id and client_request_id = p_client_request_id;
  end;

  return v_report_id;
end;
$$;

comment on function public.create_expense_report(uuid, text, text, text, uuid) is
  'Crea un borrador de rendición de forma idempotente: repetir la misma '
  'llamada con el mismo client_request_id (doble clic o reintento de red) '
  'devuelve la rendición ya creada en vez de duplicarla. La carrera real '
  'entre dos requests concurrentes la resuelve el índice único '
  'expense_reports_idempotency_key_idx, no un chequeo previo en la función.';

revoke all on function public.create_expense_report(uuid, text, text, text, uuid) from public, anon;
grant execute on function public.create_expense_report(uuid, text, text, text, uuid) to authenticated;
