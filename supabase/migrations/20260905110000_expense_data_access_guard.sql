-- P0-A: autorizacion, rate limit distribuido y auditoria atomica para toda
-- entrega de datos financieros del modulo Rendiciones. El control vive en
-- Postgres (no en memoria de una instancia Next.js), por lo que no se evade al
-- escalar horizontalmente. La funcion vuelve a comprobar tenant, permiso y
-- recurso aun cuando el Route Handler ya lo haya hecho.

create table public.expense_data_access_limits (
  company_id        uuid not null references public.companies(id) on delete cascade,
  actor_id          uuid not null references public.profiles(id) on delete cascade,
  scope             text not null check (scope in (
    'receipt.download',
    'capture.download',
    'reconciliation.export',
    'accounting.export'
  )),
  window_started_at timestamptz not null,
  request_count     integer not null check (request_count between 1 and 62),
  updated_at        timestamptz not null,
  primary key (company_id, actor_id, scope)
);

comment on table public.expense_data_access_limits is
  'Contadores acotados por empresa, actor y superficie para proteger descargas '
  'financieras en despliegues con multiples instancias. No almacena IP, '
  'nombre de archivo, filtros, payload ni contenido financiero.';

alter table public.expense_data_access_limits enable row level security;
revoke all on table public.expense_data_access_limits
  from public, anon, authenticated, service_role;

create or replace function public.authorize_expense_data_access(
  p_company_id uuid,
  p_scope text,
  p_resource_id uuid default null
)
returns table (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window_seconds integer;
  v_limit integer;
  v_window_started_at timestamptz;
  v_request_count integer;
  v_report_id uuid;
  v_authorized boolean := false;
begin
  if v_actor_id is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if p_company_id is null then
    raise exception 'Empresa requerida.' using errcode = '22023';
  end if;

  -- La autorizacion se hace dentro del SECURITY DEFINER: nunca depende de que
  -- RLS aplicada a una subconsulta complete accidentalmente este control.
  if not coalesce(public.company_has_module(p_company_id, 'expenses'), false)
     or not coalesce(public.is_active_company_member(p_company_id), false) then
    raise exception 'Acceso no autorizado.' using errcode = '42501';
  end if;

  case p_scope
    when 'receipt.download' then
      v_limit := 60;
      v_window_seconds := 300;
      if p_resource_id is null then
        raise exception 'Recurso requerido.' using errcode = '22023';
      end if;
      select er.id
      into v_report_id
      from public.expense_receipts r
      join public.expense_reports er
        on er.company_id = r.company_id and er.id = r.report_id
      where r.company_id = p_company_id
        and r.id = p_resource_id
        and r.security_status in ('VALIDATED_INTERNAL', 'CLEAN')
        and (
          er.submitted_by = v_actor_id
          or public.has_company_permission(p_company_id, 'expenses.read')
          or public.has_company_permission(p_company_id, 'expenses.approve')
          or public.has_company_permission(p_company_id, 'expenses.manage')
        );
      v_authorized := v_report_id is not null;

    when 'capture.download' then
      v_limit := 60;
      v_window_seconds := 300;
      if p_resource_id is null then
        raise exception 'Recurso requerido.' using errcode = '22023';
      end if;
      select exists (
        select 1
        from public.expense_receipt_captures c
        where c.company_id = p_company_id
          and c.id = p_resource_id
          and c.uploaded_by = v_actor_id
          and c.status = 'PENDING'
          and c.security_status in ('VALIDATED_INTERNAL', 'CLEAN')
          and (
            public.has_company_permission(p_company_id, 'expenses.submit')
            or public.has_company_permission(p_company_id, 'expenses.manage')
          )
      ) into v_authorized;

    when 'reconciliation.export' then
      v_limit := 10;
      v_window_seconds := 3600;
      if p_resource_id is not null then
        raise exception 'Esta superficie no acepta recurso.' using errcode = '22023';
      end if;
      v_authorized :=
        public.has_company_permission(p_company_id, 'expenses.reconcile')
        or public.has_company_permission(p_company_id, 'expenses.manage');

    when 'accounting.export' then
      v_limit := 20;
      v_window_seconds := 3600;
      if p_resource_id is null then
        raise exception 'Recurso requerido.' using errcode = '22023';
      end if;
      select e.report_id
      into v_report_id
      from public.expense_accounting_exports e
      where e.company_id = p_company_id
        and e.id = p_resource_id
        and (
          public.has_company_permission(p_company_id, 'expenses.reconcile')
          or public.has_company_permission(p_company_id, 'expenses.manage')
        );
      v_authorized := v_report_id is not null;

    else
      raise exception 'Superficie no permitida.' using errcode = '22023';
  end case;

  if not coalesce(v_authorized, false) then
    raise exception 'Acceso no autorizado.' using errcode = '42501';
  end if;

  v_window_started_at := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from v_now) / v_window_seconds)
      * v_window_seconds
  );

  -- El UPSERT es la unidad de serializacion. request_count se satura en
  -- limite+2 para distinguir el primer bloqueo (que se audita) de los
  -- siguientes (que no pueden amplificar indefinidamente el ledger).
  insert into public.expense_data_access_limits as limits (
    company_id, actor_id, scope, window_started_at, request_count, updated_at
  ) values (
    p_company_id, v_actor_id, p_scope, v_window_started_at, 1, v_now
  )
  on conflict (company_id, actor_id, scope) do update
  set window_started_at = excluded.window_started_at,
      request_count = case
        when limits.window_started_at <> excluded.window_started_at then 1
        else least(limits.request_count + 1, v_limit + 2)
      end,
      updated_at = excluded.updated_at
  returning limits.window_started_at,
            limits.request_count
  into v_window_started_at, v_request_count;

  allowed := v_request_count <= v_limit;
  request_limit := v_limit;
  remaining := greatest(v_limit - v_request_count, 0);
  retry_after_seconds := case when allowed then 0 else
    greatest(
      pg_catalog.ceil(extract(epoch from (
        v_window_started_at + pg_catalog.make_interval(secs => v_window_seconds) - v_now
      )))::integer,
      1
    )
  end;

  -- Los accesos permitidos son acotados por el propio limite. Del trafico
  -- bloqueado se registra solo la primera ocurrencia de cada ventana; de otro
  -- modo una cuenta autorizada podria convertir el ledger en un vector de DoS.
  if allowed or v_request_count = v_limit + 1 then
    insert into public.expense_audit_events (
      company_id, report_id, actor_id, event_type, metadata
    ) values (
      p_company_id,
      v_report_id,
      v_actor_id,
      case when allowed
        then 'expense_data_access.authorized'
        else 'expense_data_access.rate_limited'
      end,
      pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'scope', p_scope,
        'resource_id', p_resource_id,
        'request_count', v_request_count,
        'request_limit', v_limit,
        'retry_after_seconds', case when allowed then null else retry_after_seconds end
      ))
    );
  end if;

  return next;
end;
$$;

comment on function public.authorize_expense_data_access(uuid, text, uuid) is
  'Revalida tenant, permiso y recurso; consume un limite distribuido y deja '
  'auditoria atomica antes de entregar datos financieros. No prueba que la '
  'transferencia HTTP termino: registra autorizacion o bloqueo.';

revoke all on function public.authorize_expense_data_access(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_expense_data_access(uuid, text, uuid)
  to authenticated;
