-- Frontera confiable para aceptar XLSX de pre-nómina.
--
-- La sesión humana conserva la subida privada y toda la comparación, pero ya
-- no puede llamar directamente al commit. El único overload ejecutable corre
-- con service_role después de que un módulo server-only descargó Storage y
-- recalculó SHA-256/tamaño. Los overloads internos preservan exactamente la
-- validación de cambios diarios, ajustes y conflictos definida en 140/150.

create table private.payroll_workbook_acceptance_receipts (
  idempotency_key text primary key
    check (idempotency_key ~ '^[a-f0-9]{64}$'),
  actor_id uuid not null references public.profiles(id),
  company_id uuid not null references public.companies(id),
  reporting_period_id uuid not null references public.reporting_periods(id),
  expected_base_version_id uuid references public.payroll_workbook_versions(id),
  source_revision bigint not null check (source_revision >= 0),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  file_size integer not null check (file_size between 1 and 15728640),
  version_id uuid not null references public.payroll_workbook_versions(id),
  committed_storage_path text not null,
  created_at timestamptz not null default clock_timestamp()
);

create index payroll_workbook_acceptance_receipts_version_idx
  on private.payroll_workbook_acceptance_receipts(version_id);

alter table private.payroll_workbook_acceptance_receipts enable row level security;
revoke all on table private.payroll_workbook_acceptance_receipts
  from public, anon, authenticated, service_role;

comment on table private.payroll_workbook_acceptance_receipts is
  'Recibo transaccional server-only para recuperar sin duplicar una aceptación cuyo resultado HTTP fue ambiguo.';

-- Las implementaciones de 140 y 150 pasan a ser auxiliares inaccesibles. La
-- nueva función SECURITY DEFINER puede llamarlas como propietaria y conserva
-- así sus allowlists y la normalización ya auditada.
revoke all on function public.register_accepted_payroll_workbook(
  uuid, date, date, uuid, text, integer, text, text, jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.register_accepted_payroll_workbook(
  uuid, date, date, uuid, text, integer, text, text, jsonb, bigint
) from public, anon, authenticated, service_role;

-- Camino antiguo de dos pasos, actualmente sin INSERT directo para sesiones,
-- también queda clausurado para evitar que vuelva a abrir un bypass futuro.
revoke all on function public.accept_payroll_workbook_version(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.register_accepted_payroll_workbook(
  p_actor_id uuid,
  p_company_id uuid,
  p_period_start date,
  p_period_end date,
  p_expected_base_version_id uuid,
  p_content_sha256 text,
  p_file_size integer,
  p_storage_path text,
  p_general_reason text,
  p_changes jsonb,
  p_expected_source_revision bigint,
  p_verified_content_sha256 text,
  p_verified_file_size integer,
  p_idempotency_key text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_period_id uuid;
  v_receipt private.payroll_workbook_acceptance_receipts%rowtype;
  v_version public.payroll_workbook_versions%rowtype;
  v_version_id uuid;
begin
  -- Se comprueba antes de reemplazar localmente los claims que necesitan los
  -- auxiliares legacy. Ninguna sesión authenticated posee EXECUTE aquí.
  if auth.role() is distinct from 'service_role' then
    raise exception 'La aceptación verificada pertenece al servicio de pre-nómina.'
      using errcode = '42501';
  end if;

  if p_actor_id is null
     or p_company_id is null
     or p_period_start is null
     or p_period_end is null
     or p_expected_source_revision is null
     or p_expected_source_revision < 0
     or p_content_sha256 is null
     or p_content_sha256 !~ '^[a-f0-9]{64}$'
     or p_verified_content_sha256 is distinct from p_content_sha256
     or p_file_size is null
     or p_file_size not between 1 and 15728640
     or p_verified_file_size is distinct from p_file_size
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[a-f0-9]{64}$' then
    raise exception 'La evidencia verificada del XLSX no es válida.'
      using errcode = '22023';
  end if;

  -- El actor cruza explícitamente la frontera server-only. Se revalida tanto
  -- su identidad como el rol y la membresía activos del tenant; un
  -- SUPER_ADMIN técnico o un ADMIN_RRHH de otra empresa nunca puede decidir.
  if not exists (
    select 1
    from public.profiles p
    join public.company_memberships cm
      on cm.user_id = p.id
     and cm.company_id = p_company_id
     and cm.active
    join public.company_membership_roles cmr
      on cmr.company_id = cm.company_id
     and cmr.membership_id = cm.id
    join public.company_roles cr
      on cr.company_id = cmr.company_id
     and cr.id = cmr.role_id
     and cr.active
     and cr.base_role = 'ADMIN_RRHH'
    join public.companies c
      on c.id = cm.company_id
     and c.active
     and c.status = 'ACTIVE'
     and c.workspace_enabled
    where p.id = p_actor_id
      and p.active
  ) then
    raise exception 'La autoridad de RR. HH. ya no está vigente.'
      using errcode = '42501';
  end if;

  select rp.id into v_period_id
  from public.reporting_periods rp
  where rp.period_start = p_period_start
    and rp.period_end = p_period_end;
  if v_period_id is null then
    raise exception 'El período no existe para esta empresa.' using errcode = '22023';
  end if;

  -- Orden global de locks: advisory de fuentes -> revisión -> libro/período.
  -- El fence de cada writer toma el mismo advisory antes de bloquear filas;
  -- así no existe inversión con aprobación o cierre.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  perform 1
  from private.payroll_source_revisions r
  where r.company_id = p_company_id
  for update;
  if not found then
    raise exception 'No existe revisión de fuentes para la empresa.' using errcode = '55000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'payroll-workbook|' || p_company_id::text || '|' || v_period_id::text,
      0
    )
  );

  -- Recuperación fuerte: si la primera respuesta HTTP se perdió después del
  -- COMMIT, la misma huella retorna exactamente la versión ya registrada.
  select * into v_receipt
  from private.payroll_workbook_acceptance_receipts r
  where r.idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_receipt.actor_id is distinct from p_actor_id
       or v_receipt.company_id is distinct from p_company_id
       or v_receipt.reporting_period_id is distinct from v_period_id
       or v_receipt.expected_base_version_id is distinct from p_expected_base_version_id
       or v_receipt.source_revision is distinct from p_expected_source_revision
       or v_receipt.content_sha256 is distinct from p_content_sha256
       or v_receipt.file_size is distinct from p_file_size
       or not exists (
         select 1
         from public.payroll_workbook_versions v
         join private.payroll_workbook_source_attestations a
           on a.workbook_version_id = v.id
          and a.company_id = v.company_id
          and a.source_revision = v_receipt.source_revision
         where v.id = v_receipt.version_id
           and v.company_id = v_receipt.company_id
           and v.reporting_period_id = v_receipt.reporting_period_id
           and v.base_version_id is not distinct from v_receipt.expected_base_version_id
           and v.status = 'ACCEPTED'
           and v.content_sha256 = v_receipt.content_sha256
           and v.file_size = v_receipt.file_size
           and v.storage_path = v_receipt.committed_storage_path
       ) then
      raise exception 'El recibo idempotente no coincide con su evidencia inmutable.'
        using errcode = '55000';
    end if;
    return v_receipt.version_id;
  end if;

  -- Las funciones previas derivan auth.uid()/AAL del JWT. Solo después de
  -- verificar service_role + actor/tenant se proporciona el contexto local de
  -- la sesión humana que la ruta ya autenticó con MFA. SET LOCAL desaparece al
  -- terminar la transacción y no concede EXECUTE a authenticated.
  perform pg_catalog.set_config('request.jwt.claim.sub', p_actor_id::text, true);
  perform pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.jsonb_build_object(
      'sub', p_actor_id::text,
      'role', 'authenticated',
      'aal', 'aal2'
    )::text,
    true
  );

  v_version_id := public.register_accepted_payroll_workbook(
    p_company_id,
    p_period_start,
    p_period_end,
    p_expected_base_version_id,
    p_content_sha256,
    p_file_size,
    p_storage_path,
    p_general_reason,
    p_changes,
    p_expected_source_revision
  );

  select * into v_version
  from public.payroll_workbook_versions v
  where v.id = v_version_id;
  if not found
     or v_version.company_id is distinct from p_company_id
     or v_version.reporting_period_id is distinct from v_period_id
     or v_version.base_version_id is distinct from p_expected_base_version_id
     or v_version.status <> 'ACCEPTED'
     or v_version.content_sha256 is distinct from p_content_sha256
     or v_version.file_size is distinct from p_file_size
     or not exists (
       select 1
       from private.payroll_workbook_source_attestations a
       where a.workbook_version_id = v_version_id
         and a.company_id = p_company_id
         and a.source_revision = p_expected_source_revision
     ) then
    raise exception 'El commit interno no produjo evidencia aceptada consistente.'
      using errcode = '55000';
  end if;

  insert into private.payroll_workbook_acceptance_receipts (
    idempotency_key, actor_id, company_id, reporting_period_id,
    expected_base_version_id, source_revision, content_sha256, file_size,
    version_id, committed_storage_path
  ) values (
    p_idempotency_key, p_actor_id, p_company_id, v_period_id,
    p_expected_base_version_id, p_expected_source_revision,
    p_content_sha256, p_file_size, v_version_id, v_version.storage_path
  );

  return v_version_id;
end;
$$;

revoke all on function public.register_accepted_payroll_workbook(
  uuid, uuid, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text
) from public, anon, authenticated, service_role;
grant execute on function public.register_accepted_payroll_workbook(
  uuid, uuid, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text
) to service_role;

comment on function public.register_accepted_payroll_workbook(
  uuid, uuid, date, date, uuid, text, integer, text, text, jsonb,
  bigint, text, integer, text
) is
  'Commit service_role-only: revalida actor ADMIN_RRHH/tenant, exige hash y tamaño recalculados y conserva recibo idempotente para recuperación segura.';
