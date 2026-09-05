-- P0-A: lectura multiempresa y entrega controlada de documentos laborales.
--
-- La policy historica autorizaba el bucket y la tabla solo por rol global.
-- En una plataforma con varias empresas eso permitia a un ADMIN_RRHH activo
-- leer documentos de empresas donde ya no tenia membresia. Ademas, el Route
-- Handler redirigia a una signed URL sin cuota ni auditoria. Este cambio hace
-- que empresa + MFA + recurso sean autoridad de base y deja un contador
-- compartido antes de que Next.js entregue los bytes.

create table public.workforce_data_access_limits (
  company_id        uuid not null references public.companies(id) on delete cascade,
  actor_id          uuid not null references public.profiles(id) on delete cascade,
  scope             text not null check (scope in ('supporting_document.download')),
  window_started_at timestamptz not null,
  request_count     integer not null check (request_count between 1 and 62),
  updated_at        timestamptz not null,
  primary key (company_id, actor_id, scope)
);

comment on table public.workforce_data_access_limits is
  'Contadores distribuidos por empresa, actor y superficie para entregas de '
  'datos laborales sensibles. No almacena rutas, filenames ni contenido.';

alter table public.workforce_data_access_limits enable row level security;
revoke all on table public.workforce_data_access_limits
  from public, anon, authenticated, service_role;

-- Helper booleano utilizable desde RLS/Storage. A diferencia de
-- enforce_mfa_for_privileged(), no levanta una excepcion dentro de una policy.
create or replace function public.current_actor_satisfies_mfa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and (
      not public.account_requires_mfa(auth.uid())
      or public.request_is_aal2()
    );
$$;

comment on function public.current_actor_satisfies_mfa() is
  'True si la sesion actual no requiere MFA o si el JWT actual ya esta en AAL2. '
  'Solo evalua al actor actual; no permite sondear otros usuarios.';

revoke all on function public.current_actor_satisfies_mfa() from public, anon;
grant execute on function public.current_actor_satisfies_mfa() to authenticated;

create or replace function public.can_read_supporting_document_employee(p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and public.is_privileged_admin()
    and public.employee_belongs_to_active_company(p_employee_id)
    and public.current_actor_satisfies_mfa();
$$;

comment on function public.can_read_supporting_document_employee(uuid) is
  'Autoridad cerrada para contenido documental: rol RRHH privilegiado, '
  'membresia activa en la empresa real del trabajador y MFA cuando corresponde.';

revoke all on function public.can_read_supporting_document_employee(uuid) from public, anon;
grant execute on function public.can_read_supporting_document_employee(uuid) to authenticated;

create or replace function public.can_read_supporting_document_path(p_storage_path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and exists (
    select 1
    from public.supporting_documents d
    where d.storage_path = p_storage_path
      and public.can_read_supporting_document_employee(d.employee_id)
  );
$$;

comment on function public.can_read_supporting_document_path(text) is
  'Storage solo entrega una ruta ya registrada cuyo trabajador pertenece a '
  'una empresa activa del actor y cuyo request satisface MFA.';

revoke all on function public.can_read_supporting_document_path(text) from public, anon;
grant execute on function public.can_read_supporting_document_path(text) to authenticated;

-- La tabla base contiene storage_path y queda reservada a RRHH de la empresa.
drop policy if exists supporting_documents_select_admin on public.supporting_documents;
create policy supporting_documents_select_admin on public.supporting_documents
  for select to authenticated
  using (public.can_read_supporting_document_employee(employee_id));

drop policy if exists supporting_documents_update_admin on public.supporting_documents;
create policy supporting_documents_update_admin on public.supporting_documents
  for update to authenticated
  using (public.can_read_supporting_document_employee(employee_id))
  with check (public.can_read_supporting_document_employee(employee_id));

-- La vista no expone storage_path, pero sigue siendo metadata sensible. La
-- membresia de empresa y el nivel MFA se aplican a todas sus ramas, incluida
-- la excepcion del autor historico.
create or replace view public.supporting_documents_metadata
with (security_invoker = false)
as
select
  id,
  employee_id,
  absence_record_id,
  late_arrival_decision_id,
  attendance_status_record_id,
  document_type,
  original_filename,
  mime_type,
  uploaded_by,
  uploaded_at,
  created_at
from public.supporting_documents
where
  public.is_corporate_user()
  and public.employee_belongs_to_active_company(employee_id)
  and public.current_actor_satisfies_mfa()
  and (
    public.is_privileged_admin()
    or uploaded_by = auth.uid()
    or public.can_manage_employee(employee_id)
  );

comment on view public.supporting_documents_metadata is
  'Metadata sin storage_path, limitada a perfiles activos, MFA aplicable y '
  'membresia vigente en la empresa real del trabajador.';

grant select on public.supporting_documents_metadata to authenticated;
revoke all on public.supporting_documents_metadata from anon, public;

drop policy if exists supporting_documents_storage_select_admin on storage.objects;
create policy supporting_documents_storage_select_admin
  on storage.objects for select to authenticated
  using (
    bucket_id = 'supporting-documents'
    and public.can_read_supporting_document_path(name)
  );

create or replace function public.authorize_supporting_document_download(p_document_id uuid)
returns table (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer,
  storage_path text,
  original_filename text,
  mime_type text
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_company_id uuid;
  v_storage_path text;
  v_original_filename text;
  v_mime_type text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window_started_at timestamptz;
  v_request_count integer;
  v_limit constant integer := 60;
  v_window_seconds constant integer := 300;
begin
  if v_actor_id is null then
    raise exception 'Autenticacion requerida.' using errcode = '42501';
  end if;
  if p_document_id is null then
    raise exception 'Documento requerido.' using errcode = '22023';
  end if;

  -- La condicion compone rol, empresa y MFA. El SECURITY DEFINER nunca usa
  -- una fila visible por accidente como sustituto de autorizacion explicita.
  select e.company_id, d.storage_path, d.original_filename, d.mime_type
  into v_company_id, v_storage_path, v_original_filename, v_mime_type
  from public.supporting_documents d
  join public.employees e on e.id = d.employee_id
  where d.id = p_document_id
    and public.can_read_supporting_document_employee(d.employee_id);

  if v_company_id is null then
    raise exception 'Acceso no autorizado.' using errcode = '42501';
  end if;

  v_window_started_at := pg_catalog.to_timestamp(
    pg_catalog.floor(extract(epoch from v_now) / v_window_seconds)
      * v_window_seconds
  );

  insert into public.workforce_data_access_limits as limits (
    company_id, actor_id, scope, window_started_at, request_count, updated_at
  ) values (
    v_company_id, v_actor_id, 'supporting_document.download',
    v_window_started_at, 1, v_now
  )
  on conflict (company_id, actor_id, scope) do update
  set window_started_at = excluded.window_started_at,
      request_count = case
        when limits.window_started_at <> excluded.window_started_at then 1
        else least(limits.request_count + 1, v_limit + 2)
      end,
      updated_at = excluded.updated_at
  returning limits.window_started_at, limits.request_count
  into v_window_started_at, v_request_count;

  allowed := v_request_count <= v_limit;
  request_limit := v_limit;
  remaining := greatest(v_limit - v_request_count, 0);
  retry_after_seconds := case when allowed then 0 else
    greatest(
      pg_catalog.ceil(extract(epoch from (
        v_window_started_at
        + pg_catalog.make_interval(secs => v_window_seconds)
        - v_now
      )))::integer,
      1
    )
  end;

  if allowed then
    storage_path := v_storage_path;
    original_filename := v_original_filename;
    mime_type := v_mime_type;
  else
    -- Una respuesta 429 nunca filtra metadata del documento.
    storage_path := null;
    original_filename := null;
    mime_type := null;
  end if;

  -- El ledger registra autorizacion (no prueba de transferencia completa).
  -- El primer bloqueo se registra una vez; los siguientes se saturan para no
  -- convertir la propia auditoria en un vector de amplificacion.
  if allowed or v_request_count = v_limit + 1 then
    insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
    values (
      v_actor_id,
      case when allowed
        then 'SUPPORTING_DOCUMENT_DOWNLOAD_AUTHORIZED'
        else 'SUPPORTING_DOCUMENT_DOWNLOAD_RATE_LIMITED'
      end,
      'supporting_documents',
      p_document_id,
      pg_catalog.jsonb_build_object(
        'company_id', v_company_id,
        'scope', 'supporting_document.download',
        'request_count', v_request_count,
        'request_limit', v_limit,
        'retry_after_seconds', case when allowed then null else retry_after_seconds end
      )
    );
  end if;

  return next;
end;
$$;

comment on function public.authorize_supporting_document_download(uuid) is
  'Revalida rol, empresa, MFA y documento; consume limite distribuido y audita '
  'antes de devolver la ruta privada a la aplicacion. No entrega una signed URL.';

revoke all on function public.authorize_supporting_document_download(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.authorize_supporting_document_download(uuid)
  to authenticated;
