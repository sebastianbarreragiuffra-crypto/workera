-- GESTORA Rendiciones Fase 3: importación bancaria y conciliación asistida.
-- Las sugerencias son deterministas; ninguna regla marca un pago por sí sola.

create type public.expense_bank_transaction_status as enum ('UNMATCHED', 'MATCHED', 'IGNORED');

create table public.expense_bank_imports (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references public.companies(id) on delete restrict,
  uploaded_by          uuid not null references public.profiles(id),
  source_channel       text not null check (source_channel in ('WEB_CSV', 'BANK_API')),
  content_checksum_sha256 text not null check (content_checksum_sha256 ~ '^[0-9a-f]{64}$'),
  row_count            integer not null check (row_count between 1 and 2000),
  imported_at          timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, content_checksum_sha256)
);

-- Contador interno de intentos. A diferencia del historial de importaciones,
-- incluye reintentos idempotentes y payloads rechazados tras la validación
-- profunda. No se expone al navegador.
create table public.expense_bank_import_usage_windows (
  company_id        uuid not null references public.companies(id) on delete cascade,
  window_started_at timestamptz not null,
  scope_key         text not null check (
    scope_key = 'COMPANY'
    or scope_key ~ '^USER:[0-9a-f-]{36}$'
    or scope_key = 'INGRESS:COMPANY'
    or scope_key ~ '^INGRESS:USER:[0-9a-f-]{36}$'
  ),
  attempt_count     integer not null check (attempt_count between 1 and 100),
  payload_bytes     bigint not null check (payload_bytes between 0 and 209715200),
  updated_at        timestamptz not null default now(),
  primary key (company_id, window_started_at, scope_key)
);

create table public.expense_bank_transactions (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null,
  import_id            uuid not null,
  source_row_number    integer not null check (source_row_number between 1 and 2000),
  transaction_date     date not null,
  amount               numeric(16,2) not null check (amount > 0),
  currency_code        text not null check (currency_code ~ '^[A-Z]{3}$'),
  bank_reference       text not null check (char_length(btrim(bank_reference)) between 1 and 120),
  description          text check (description is null or char_length(description) between 1 and 240),
  match_fingerprint    text not null check (match_fingerprint ~ '^[0-9a-f]{64}$'),
  status               public.expense_bank_transaction_status not null default 'UNMATCHED',
  matched_report_id    uuid,
  matched_by           uuid references public.profiles(id),
  matched_at           timestamptz,
  match_method         text check (match_method is null or match_method in ('MANUAL', 'SUGGESTED')),
  ignored_reason       text check (ignored_reason is null or char_length(btrim(ignored_reason)) between 3 and 240),
  created_at           timestamptz not null default now(),
  unique (company_id, id),
  unique (import_id, source_row_number),
  constraint expense_bank_transactions_import_fk foreign key (company_id, import_id)
    references public.expense_bank_imports(company_id, id) on delete restrict,
  constraint expense_bank_transactions_report_fk foreign key (company_id, matched_report_id)
    references public.expense_reports(company_id, id) on delete restrict,
  constraint expense_bank_transactions_state_chk check (
    (status = 'UNMATCHED' and matched_report_id is null and matched_by is null and matched_at is null
      and match_method is null and ignored_reason is null)
    or (status = 'MATCHED' and matched_report_id is not null and matched_by is not null and matched_at is not null
      and match_method is not null and ignored_reason is null)
    or (status = 'IGNORED' and matched_report_id is null and matched_by is not null and matched_at is not null
      and match_method is null and ignored_reason is not null)
  )
);

create table public.expense_reconciliation_events (
  id              bigint generated always as identity primary key,
  company_id      uuid not null,
  transaction_id  uuid not null,
  report_id       uuid,
  actor_id        uuid not null references public.profiles(id),
  event_type      text not null check (event_type in ('IMPORTED', 'MATCHED', 'IGNORED')),
  metadata        jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  occurred_at     timestamptz not null default now(),
  constraint expense_reconciliation_events_transaction_fk foreign key (company_id, transaction_id)
    references public.expense_bank_transactions(company_id, id) on delete restrict,
  constraint expense_reconciliation_events_report_fk foreign key (company_id, report_id)
    references public.expense_reports(company_id, id) on delete restrict
);

create index expense_bank_transactions_queue_idx
  on public.expense_bank_transactions(company_id, status, transaction_date desc, created_at desc);
create index expense_bank_transactions_candidate_idx
  on public.expense_bank_transactions(company_id, amount, currency_code, transaction_date)
  where status = 'UNMATCHED';
create index expense_bank_transactions_fingerprint_idx
  on public.expense_bank_transactions(company_id, match_fingerprint);
create unique index expense_bank_transactions_one_logical_payment_idx
  on public.expense_bank_transactions(company_id, match_fingerprint)
  where status = 'MATCHED';
create unique index expense_bank_transactions_one_report_idx
  on public.expense_bank_transactions(company_id, matched_report_id)
  where status = 'MATCHED';
create index expense_reconciliation_events_company_idx
  on public.expense_reconciliation_events(company_id, occurred_at desc);

alter table public.expense_bank_imports enable row level security;
alter table public.expense_bank_import_usage_windows enable row level security;
alter table public.expense_bank_transactions enable row level security;
alter table public.expense_reconciliation_events enable row level security;

create policy expense_bank_imports_read on public.expense_bank_imports
for select to authenticated using (
  public.company_has_module(company_id, 'expenses')
  and public.is_active_company_member(company_id)
  and (public.has_company_permission(company_id, 'expenses.reconcile')
    or public.has_company_permission(company_id, 'expenses.manage'))
);

create policy expense_bank_transactions_read on public.expense_bank_transactions
for select to authenticated using (
  public.company_has_module(company_id, 'expenses')
  and public.is_active_company_member(company_id)
  and (public.has_company_permission(company_id, 'expenses.reconcile')
    or public.has_company_permission(company_id, 'expenses.manage'))
);

create policy expense_reconciliation_events_read on public.expense_reconciliation_events
for select to authenticated using (
  public.company_has_module(company_id, 'expenses')
  and public.is_active_company_member(company_id)
  and (public.has_company_permission(company_id, 'expenses.reconcile')
    or public.has_company_permission(company_id, 'expenses.manage'))
);

-- Reserva cuota antes de que el Route Handler empiece a leer el cuerpo. El
-- navegador no puede ejecutar esta función; el backend entrega el actor de la
-- sesión y PostgreSQL vuelve a comprobar su membresía y permiso.
create or replace function public.claim_expense_bank_upload(
  p_actor_id uuid,
  p_company_id uuid,
  p_declared_bytes bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz := date_trunc('hour', clock_timestamp());
begin
  if p_actor_id is null or p_company_id is null then
    raise exception 'Actor y empresa son obligatorios.' using errcode = '42501';
  end if;
  if p_declared_bytes is null or p_declared_bytes not between 1 and 2097152 then
    raise exception 'La cartola supera el máximo de 2 MB.' using errcode = '54000';
  end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.reconcile')
       and not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite importar cartolas.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':expense-bank-ingress', 0));
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.reconcile')
       and not public.expense_actor_has_permission(p_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite importar cartolas.' using errcode = '42501';
  end if;

  delete from public.expense_bank_import_usage_windows
  where company_id = p_company_id and window_started_at < v_window_start - interval '48 hours';
  if coalesce((select attempt_count from public.expense_bank_import_usage_windows
      where company_id = p_company_id and window_started_at = v_window_start and scope_key = 'INGRESS:COMPANY'), 0) + 1 > 100
     or coalesce((select payload_bytes from public.expense_bank_import_usage_windows
      where company_id = p_company_id and window_started_at = v_window_start and scope_key = 'INGRESS:COMPANY'), 0) + p_declared_bytes > 209715200 then
    raise exception 'La empresa superó la cuota horaria de carga bancaria.' using errcode = '54000';
  end if;
  if coalesce((select attempt_count from public.expense_bank_import_usage_windows
      where company_id = p_company_id and window_started_at = v_window_start and scope_key = 'INGRESS:USER:' || p_actor_id::text), 0) + 1 > 20
     or coalesce((select payload_bytes from public.expense_bank_import_usage_windows
      where company_id = p_company_id and window_started_at = v_window_start and scope_key = 'INGRESS:USER:' || p_actor_id::text), 0) + p_declared_bytes > 41943040 then
    raise exception 'Superaste tu cuota horaria de carga bancaria.' using errcode = '54000';
  end if;

  insert into public.expense_bank_import_usage_windows (
    company_id, window_started_at, scope_key, attempt_count, payload_bytes
  ) values
    (p_company_id, v_window_start, 'INGRESS:COMPANY', 1, p_declared_bytes),
    (p_company_id, v_window_start, 'INGRESS:USER:' || p_actor_id::text, 1, p_declared_bytes)
  on conflict (company_id, window_started_at, scope_key) do update
  set attempt_count = public.expense_bank_import_usage_windows.attempt_count + 1,
      payload_bytes = public.expense_bank_import_usage_windows.payload_bytes + excluded.payload_bytes,
      updated_at = clock_timestamp();
end;
$$;

-- Importa filas ya validadas por el servidor web. La transacción de la función
-- garantiza que nunca quede una importación parcial.
create or replace function public.import_expense_bank_statement(
  p_actor_id uuid,
  p_company_id uuid,
  p_source_channel text,
  p_rows jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := p_actor_id;
  v_import_id uuid;
  v_row jsonb;
  v_row_number integer := 0;
  v_date date;
  v_amount numeric(16,2);
  v_currency text;
  v_reference text;
  v_description text;
  v_canonical_rows text[] := array[]::text[];
  v_content_checksum text;
  v_match_fingerprint text;
  v_window_start timestamptz;
  v_payload_bytes bigint;
begin
  if v_actor_id is null then raise exception 'Se requiere un actor autenticado.' using errcode = '42501'; end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(v_actor_id, p_company_id, 'expenses.reconcile')
       and not public.expense_actor_has_permission(v_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite importar cartolas.' using errcode = '42501';
  end if;
  if p_source_channel is null or p_source_channel not in ('WEB_CSV', 'BANK_API') then
    raise exception 'Canal de importación inválido.' using errcode = '23514';
  end if;

  v_payload_bytes := coalesce(pg_column_size(p_rows), 0);
  v_window_start := date_trunc('hour', clock_timestamp());
  -- Se serializa ANTES de recorrer el JSON. Así los intentos repetidos o
  -- repartidos entre varias cuentas del tenant consumen una cuota durable y
  -- los rechazos por exceso terminan antes del digest/validación profunda.
  perform pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':expense-bank-import', 0));
  if not public.company_has_module(p_company_id, 'expenses')
     or (not public.expense_actor_has_permission(v_actor_id, p_company_id, 'expenses.reconcile')
       and not public.expense_actor_has_permission(v_actor_id, p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite importar cartolas.' using errcode = '42501';
  end if;
  delete from public.expense_bank_import_usage_windows
  where company_id = p_company_id and window_started_at < v_window_start - interval '48 hours';
  if coalesce((select attempt_count from public.expense_bank_import_usage_windows
      where company_id = p_company_id and window_started_at = v_window_start and scope_key = 'COMPANY'), 0) + 1 > 100
     or coalesce((select payload_bytes from public.expense_bank_import_usage_windows
      where company_id = p_company_id and window_started_at = v_window_start and scope_key = 'COMPANY'), 0) + v_payload_bytes > 52428800 then
    raise exception 'La empresa superó la cuota horaria de importación bancaria.' using errcode = '54000';
  end if;
  if coalesce((select attempt_count from public.expense_bank_import_usage_windows
      where company_id = p_company_id and window_started_at = v_window_start and scope_key = 'USER:' || v_actor_id::text), 0) + 1 > 20
     or coalesce((select payload_bytes from public.expense_bank_import_usage_windows
      where company_id = p_company_id and window_started_at = v_window_start and scope_key = 'USER:' || v_actor_id::text), 0) + v_payload_bytes > 10485760 then
    raise exception 'Superaste tu cuota horaria de importación bancaria.' using errcode = '54000';
  end if;
  insert into public.expense_bank_import_usage_windows (
    company_id, window_started_at, scope_key, attempt_count, payload_bytes
  ) values
    (p_company_id, v_window_start, 'COMPANY', 1, v_payload_bytes),
    (p_company_id, v_window_start, 'USER:' || v_actor_id::text, 1, v_payload_bytes)
  on conflict (company_id, window_started_at, scope_key) do update
  set attempt_count = public.expense_bank_import_usage_windows.attempt_count + 1,
      payload_bytes = public.expense_bank_import_usage_windows.payload_bytes + excluded.payload_bytes,
      updated_at = clock_timestamp();

  -- Un error esperado de validación retorna NULL dentro de una subtransacción:
  -- sus escrituras parciales se revierten, pero el consumo de cuota anterior
  -- permanece y evita repetir indefinidamente payloads costosos.
  begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 2000 then
    raise exception 'La cartola debe contener entre 1 y 2000 movimientos.' using errcode = '23514';
  end if;
  if pg_column_size(p_rows) > 2097152 then
    raise exception 'El payload de la cartola supera 2 MB.' using errcode = '54000';
  end if;

  -- Validar y normalizar antes de adquirir el lock. El checksum lógico se
  -- calcula en PostgreSQL, no se confía en un hash aportado por el cliente.
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := v_row_number + 1;
    if jsonb_typeof(v_row) <> 'object' then
      raise exception 'Fila bancaria inválida en posición %.', v_row_number using errcode = '23514';
    end if;
    if exists (
      select 1 from jsonb_object_keys(v_row) as key
      where key not in ('date', 'amount', 'currency', 'reference', 'description')
    ) then
      raise exception 'Fila bancaria contiene columnas no permitidas en posición %.', v_row_number using errcode = '23514';
    end if;
    if jsonb_typeof(v_row->'date') <> 'string'
       or jsonb_typeof(v_row->'amount') <> 'string'
       or jsonb_typeof(v_row->'currency') <> 'string'
       or jsonb_typeof(v_row->'reference') <> 'string'
       or (v_row ? 'description' and v_row->'description' <> 'null'::jsonb
         and jsonb_typeof(v_row->'description') <> 'string')
       or coalesce(v_row->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$'
       or coalesce(v_row->>'amount', '') !~ '^\d{1,12}(\.\d{1,2})?$'
       or coalesce(v_row->>'currency', '') !~ '^[A-Z]{3}$'
       or char_length(btrim(coalesce(v_row->>'reference', ''))) not between 1 and 120
       or char_length(coalesce(nullif(btrim(v_row->>'description'), ''), 'x')) > 240 then
      raise exception 'Fila bancaria inválida en posición %.', v_row_number using errcode = '23514';
    end if;
    begin
      v_date := (v_row->>'date')::date;
      v_amount := (v_row->>'amount')::numeric(16,2);
    exception when others then
      raise exception 'Fila bancaria inválida en posición %.', v_row_number using errcode = '23514';
    end;
    if v_amount <= 0 then raise exception 'Monto inválido en posición %.', v_row_number using errcode = '23514'; end if;
    v_currency := v_row->>'currency';
    v_reference := btrim(v_row->>'reference');
    v_description := nullif(btrim(v_row->>'description'), '');
    if v_reference ~ '[[:cntrl:]]'
       or translate(v_reference, chr(1564)||chr(8206)||chr(8207)||chr(8234)||chr(8235)||chr(8236)||chr(8237)||chr(8238)||chr(8294)||chr(8295)||chr(8296)||chr(8297), '') <> v_reference
       or (v_description is not null and (
         v_description ~ '[[:cntrl:]]'
         or translate(v_description, chr(1564)||chr(8206)||chr(8207)||chr(8234)||chr(8235)||chr(8236)||chr(8237)||chr(8238)||chr(8294)||chr(8295)||chr(8296)||chr(8297), '') <> v_description
       )) then
      raise exception 'Fila bancaria contiene texto no seguro en posición %.', v_row_number using errcode = '23514';
    end if;
    v_canonical_rows := array_append(v_canonical_rows, jsonb_build_object(
      'date', v_date::text,
      'amount', v_amount::text,
      'currency', v_currency,
      'reference', lower(v_reference),
      'description', coalesce(v_description, '')
    )::text);
  end loop;

  select encode(extensions.digest(string_agg(row_value, E'\n' order by row_value), 'sha256'), 'hex')
    into v_content_checksum
  from unnest(v_canonical_rows) as canonical(row_value);

  select id into v_import_id from public.expense_bank_imports
   where company_id = p_company_id and content_checksum_sha256 = v_content_checksum;
  if v_import_id is not null then return v_import_id; end if;

  if coalesce((
    select sum(i.row_count) from public.expense_bank_imports i
    where i.company_id = p_company_id and i.uploaded_by = v_actor_id
      and i.imported_at >= clock_timestamp() - interval '24 hours'
  ), 0) + jsonb_array_length(p_rows) > 10000 then
    raise exception 'Superaste el máximo de 10.000 movimientos importados en 24 horas.' using errcode = '54000';
  end if;
  if (
    select count(*) from public.expense_bank_transactions t
    where t.company_id = p_company_id and t.status = 'UNMATCHED'
  ) + jsonb_array_length(p_rows) > 10000 then
    raise exception 'Resuelve movimientos pendientes antes de importar otra cartola.' using errcode = '54000';
  end if;

  insert into public.expense_bank_imports (
    company_id, uploaded_by, source_channel, content_checksum_sha256, row_count
  ) values (
    p_company_id, v_actor_id, p_source_channel, v_content_checksum, jsonb_array_length(p_rows)
  ) returning id into v_import_id;

  v_row_number := 0;
  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_row_number := v_row_number + 1;
    v_date := (v_row->>'date')::date;
    v_amount := (v_row->>'amount')::numeric(16,2);
    v_currency := v_row->>'currency';
    v_reference := btrim(v_row->>'reference');
    v_description := nullif(btrim(v_row->>'description'), '');
    v_match_fingerprint := encode(extensions.digest(jsonb_build_object(
      'date', v_date::text,
      'amount', v_amount::text,
      'currency', v_currency,
      'reference', lower(v_reference)
    )::text, 'sha256'), 'hex');

    insert into public.expense_bank_transactions (
      company_id, import_id, source_row_number, transaction_date, amount,
      currency_code, bank_reference, description, match_fingerprint
    ) values (
      p_company_id, v_import_id, v_row_number, v_date, v_amount,
      v_currency, v_reference, v_description, v_match_fingerprint
    );
  end loop;

  insert into public.expense_reconciliation_events (
    company_id, transaction_id, actor_id, event_type, metadata
  )
  select p_company_id, t.id, v_actor_id, 'IMPORTED', jsonb_build_object('import_id', v_import_id)
  from public.expense_bank_transactions t
  where t.company_id = p_company_id and t.import_id = v_import_id;

  return v_import_id;
  exception
    -- Las validaciones de fila esperadas retornan NULL conservando la cuota.
    -- Los límites 54000 deben propagarse para que HTTP responda 429, no 500.
    when check_violation then
      return null;
  end;
end;
$$;

create or replace function public.list_expense_reconciliation_candidates(
  p_company_id uuid,
  p_transaction_id uuid
)
returns table (
  report_id uuid,
  reference_number text,
  title text,
  submitter_name text,
  submitted_at timestamptz,
  total_amount numeric,
  currency_code text,
  date_distance_days integer,
  score integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_date date;
  v_amount numeric(16,2);
  v_currency text;
begin
  if auth.uid() is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if not public.company_has_module(p_company_id, 'expenses')
     or not public.is_active_company_member(p_company_id)
     or (not public.has_company_permission(p_company_id, 'expenses.reconcile')
       and not public.has_company_permission(p_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite conciliar rendiciones.' using errcode = '42501';
  end if;

  select t.transaction_date, t.amount, t.currency_code
    into v_date, v_amount, v_currency
  from public.expense_bank_transactions t
  where t.company_id = p_company_id and t.id = p_transaction_id and t.status = 'UNMATCHED';
  if not found then raise exception 'Movimiento bancario no disponible.' using errcode = '23503'; end if;

  return query
  select er.id, er.reference_number, er.title, p.display_name, er.submitted_at,
    er.total_amount, er.currency_code,
    abs(v_date - timezone('America/Santiago', coalesce(er.submitted_at, er.created_at))::date)::integer,
    (130 - least(30, abs(v_date - timezone('America/Santiago', coalesce(er.submitted_at, er.created_at))::date)::integer))::integer
  from public.expense_reports er
  join public.profiles p on p.id = er.submitted_by
  where er.company_id = p_company_id
    and er.status = 'APPROVED'
    and er.total_amount = v_amount
    and er.currency_code = v_currency
    and abs(v_date - timezone('America/Santiago', coalesce(er.submitted_at, er.created_at))::date) <= 45
  order by abs(v_date - timezone('America/Santiago', coalesce(er.submitted_at, er.created_at))::date), er.submitted_at, er.id
  limit 10;
end;
$$;

create or replace function public.match_expense_bank_transaction(
  p_transaction_id uuid,
  p_report_id uuid,
  p_method text default 'MANUAL'
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
  v_transaction_status public.expense_bank_transaction_status;
  v_date date;
  v_amount numeric(16,2);
  v_currency text;
  v_reference text;
  v_match_fingerprint text;
  v_report_status public.expense_report_status;
  v_report_amount numeric(16,2);
  v_report_currency text;
  v_report_date date;
  v_effective_method text;
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if p_method is null or p_method not in ('MANUAL', 'SUGGESTED') then raise exception 'Método inválido.' using errcode = '23514'; end if;

  select t.company_id, t.status, t.transaction_date, t.amount, t.currency_code, t.bank_reference, t.match_fingerprint
    into v_company_id, v_transaction_status, v_date, v_amount, v_currency, v_reference, v_match_fingerprint
  from public.expense_bank_transactions t where t.id = p_transaction_id for update;
  if not found then raise exception 'Movimiento bancario inexistente.' using errcode = '23503'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_company_id::text || ':expense-payment:' || v_match_fingerprint, 0));
  if not public.company_has_module(v_company_id, 'expenses')
     or not public.is_active_company_member(v_company_id)
     or (not public.has_company_permission(v_company_id, 'expenses.reconcile')
       and not public.has_company_permission(v_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite conciliar rendiciones.' using errcode = '42501';
  end if;
  if v_transaction_status <> 'UNMATCHED' then raise exception 'El movimiento ya fue resuelto.' using errcode = '23514'; end if;
  if exists (
    select 1 from public.expense_bank_transactions t
    where t.company_id = v_company_id and t.match_fingerprint = v_match_fingerprint
      and t.status = 'MATCHED' and t.id <> p_transaction_id
  ) then
    raise exception 'Este pago bancario ya fue conciliado.' using errcode = '23514';
  end if;

  select er.status, er.total_amount, er.currency_code,
    timezone('America/Santiago', coalesce(er.submitted_at, er.created_at))::date
    into v_report_status, v_report_amount, v_report_currency, v_report_date
  from public.expense_reports er
  where er.company_id = v_company_id and er.id = p_report_id for update;
  if not found then raise exception 'Rendición inexistente en esta empresa.' using errcode = '23503'; end if;
  if v_report_status <> 'APPROVED' then raise exception 'Solo se puede asociar una rendición aprobada.' using errcode = '23514'; end if;
  if v_report_amount <> v_amount or v_report_currency <> v_currency then
    raise exception 'Monto o moneda no coinciden.' using errcode = '23514';
  end if;
  -- El cliente no decide qué queda auditado como sugerencia. Aunque conserve el
  -- parámetro por compatibilidad, el servidor deriva el método de la misma regla
  -- temporal usada por list_expense_reconciliation_candidates().
  v_effective_method := case when abs(v_date - v_report_date) <= 45 then 'SUGGESTED' else 'MANUAL' end;

  update public.expense_bank_transactions
  set status = 'MATCHED', matched_report_id = p_report_id, matched_by = v_actor_id,
      matched_at = clock_timestamp(), match_method = v_effective_method
  where company_id = v_company_id and id = p_transaction_id;

  update public.expense_reports
  set status = 'PAID', paid_at = clock_timestamp(), paid_by = v_actor_id,
      payment_reference = left('BANCO ' || v_reference, 160)
  where company_id = v_company_id and id = p_report_id;

  insert into public.expense_reconciliation_events (
    company_id, transaction_id, report_id, actor_id, event_type, metadata
  ) values (
    v_company_id, p_transaction_id, p_report_id, v_actor_id, 'MATCHED',
    jsonb_build_object('method', v_effective_method, 'transaction_date', v_date)
  );
end;
$$;

create or replace function public.ignore_expense_bank_transaction(
  p_transaction_id uuid,
  p_reason text
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
  v_status public.expense_bank_transaction_status;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_actor_id is null then raise exception 'Se requiere una sesión autenticada.' using errcode = '42501'; end if;
  if v_reason is null or char_length(v_reason) not between 3 and 240 then
    raise exception 'Debes indicar un motivo.' using errcode = '23514';
  end if;
  select company_id, status into v_company_id, v_status
  from public.expense_bank_transactions where id = p_transaction_id for update;
  if not found then raise exception 'Movimiento bancario inexistente.' using errcode = '23503'; end if;
  if not public.company_has_module(v_company_id, 'expenses')
     or not public.is_active_company_member(v_company_id)
     or (not public.has_company_permission(v_company_id, 'expenses.reconcile')
       and not public.has_company_permission(v_company_id, 'expenses.manage')) then
    raise exception 'Tu rol no permite conciliar rendiciones.' using errcode = '42501';
  end if;
  if v_status <> 'UNMATCHED' then raise exception 'El movimiento ya fue resuelto.' using errcode = '23514'; end if;

  update public.expense_bank_transactions
  set status = 'IGNORED', matched_by = v_actor_id, matched_at = clock_timestamp(), ignored_reason = v_reason
  where company_id = v_company_id and id = p_transaction_id;
  insert into public.expense_reconciliation_events (
    company_id, transaction_id, actor_id, event_type, metadata
  ) values (v_company_id, p_transaction_id, v_actor_id, 'IGNORED', jsonb_build_object('reason', v_reason));
end;
$$;

revoke all on public.expense_bank_imports, public.expense_bank_import_usage_windows, public.expense_bank_transactions,
  public.expense_reconciliation_events from public, anon, authenticated;
grant select on public.expense_bank_imports, public.expense_bank_transactions,
  public.expense_reconciliation_events to authenticated;
grant select, insert on public.expense_bank_imports, public.expense_bank_transactions,
  public.expense_reconciliation_events to service_role;
grant select, insert, update, delete on public.expense_bank_import_usage_windows to service_role;
grant update on public.expense_bank_transactions to service_role;

revoke all on function public.import_expense_bank_statement(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.claim_expense_bank_upload(uuid, uuid, bigint) from public, anon, authenticated, service_role;
revoke all on function public.list_expense_reconciliation_candidates(uuid, uuid) from public, anon;
revoke all on function public.match_expense_bank_transaction(uuid, uuid, text) from public, anon;
revoke all on function public.ignore_expense_bank_transaction(uuid, text) from public, anon;
grant execute on function public.import_expense_bank_statement(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.claim_expense_bank_upload(uuid, uuid, bigint) to service_role;
grant execute on function public.list_expense_reconciliation_candidates(uuid, uuid) to authenticated;
grant execute on function public.match_expense_bank_transaction(uuid, uuid, text) to authenticated;
grant execute on function public.ignore_expense_bank_transaction(uuid, text) to authenticated;

comment on table public.expense_bank_transactions is
  'Movimientos bancarios mínimos, aislados por empresa, usados para conciliación humana. No almacena números de cuenta ni payloads bancarios crudos.';
comment on table public.expense_bank_import_usage_windows is
  'Cuotas internas por hora, empresa y actor. Separa ingreso HTTP de procesamiento y cuenta duplicados y rechazos; no se expone a usuarios autenticados.';
comment on function public.list_expense_reconciliation_candidates(uuid, uuid) is
  'Sugiere hasta diez rendiciones aprobadas por reglas deterministas de monto, moneda y cercanía temporal. Nunca cambia estados.';
comment on function public.match_expense_bank_transaction(uuid, uuid, text) is
  'Con confirmación humana, enlaza movimiento y rendición y marca PAID en una sola transacción PostgreSQL.';
