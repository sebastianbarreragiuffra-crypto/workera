-- Vincula cada reserva de cierre con la evidencia exacta que RR. HH. aprobó.
-- NULL se conserva únicamente para operaciones históricas creadas antes de
-- esta migración; ninguna reserva nueva ni commit pendiente puede usarlo.
alter table private.payroll_period_close_operations
  add column readiness_sha256 text;

alter table private.payroll_period_close_operations
  add constraint payroll_period_close_operations_readiness_sha256_chk
  check (
    readiness_sha256 is null
    or readiness_sha256 ~ '^[a-f0-9]{64}$'
  );

comment on column private.payroll_period_close_operations.readiness_sha256 is
  'SHA-256 de readiness aprobado por RR. HH.; NULL solo identifica operaciones históricas previas a esta migración.';

-- El digest de readiness incorporó el padrón autorizado y una etiqueta de
-- esquema V2. Toda aprobación activa anterior usa necesariamente el contrato
-- V1, por lo que se invalida y se devuelve el período a revisión. No se tocan
-- períodos cerrados ni se fabrica una aprobación nueva automáticamente.
update public.reporting_period_approvals approval
set invalidated_at = clock_timestamp(),
    invalidation_reason = 'PROTOCOLO_READINESS_V2'
where approval.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
  and approval.invalidated_at is null;

update public.reporting_periods period
set status = 'IN_REVIEW'
where period.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
  and period.status = 'READY_TO_CLOSE';

-- Las descargas deben pasar por la ruta autenticada que verifica empresa,
-- propósito, identidad técnica y padrón de 45. Sin esta policy, un cliente
-- autenticado no puede saltarse esos controles consultando Storage directo;
-- la frontera server-only conserva acceso mediante service_role.
drop policy if exists payroll_workbooks_storage_read on storage.objects;

-- CREATE OR REPLACE con un parámetro adicional crearía un overload y dejaría
-- accesible el contrato antiguo. Se elimina explícitamente para que no exista
-- una ruta autenticada capaz de omitir el digest aprobado.
drop function if exists public.prepare_payroll_period_close(
  uuid, uuid, uuid, public.reporting_period_status, uuid, bigint, text, integer, text
);

create function public.prepare_payroll_period_close(
  p_operation_id uuid,
  p_company_id uuid,
  p_reporting_period_id uuid,
  p_expected_status public.reporting_period_status,
  p_expected_base_version_id uuid,
  p_expected_source_revision bigint,
  p_expected_readiness_sha256 text,
  p_content_sha256 text,
  p_file_size integer,
  p_storage_path text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_period public.reporting_periods%rowtype;
  v_latest uuid;
  v_current_revision bigint;
  v_approval_id uuid;
  v_existing private.payroll_period_close_operations%rowtype;
  v_existing_found boolean := false;
begin
  if v_actor is null
     or p_company_id is distinct from '0a4c0000-0000-0000-0000-000000000001'::uuid
     or not coalesce(public.has_company_app_role(p_company_id, 'ADMIN_RRHH'), false) then
    raise exception 'Solo RR. HH. de la empresa activa puede preparar el cierre.'
      using errcode = '42501';
  end if;
  perform public.enforce_mfa_for_privileged();

  if not coalesce(public.request_is_aal2(), false) then
    raise exception 'Esta operación de RR. HH. exige segundo factor (MFA).'
      using errcode = '42501';
  end if;

  if p_operation_id is null
     or p_reporting_period_id is null
     or p_expected_status is distinct from 'READY_TO_CLOSE'::public.reporting_period_status
     or p_expected_base_version_id is null
     or p_expected_source_revision is null
     or p_expected_source_revision < 0
     or p_expected_readiness_sha256 is null
     or p_expected_readiness_sha256 !~ '^[a-f0-9]{64}$'
     or p_content_sha256 is null
     or p_content_sha256 !~ '^[a-f0-9]{64}$'
     or p_file_size is null
     or p_file_size not between 1 and 15728640 then
    raise exception 'La evidencia preparada del cierre es inválida.' using errcode = '22023';
  end if;

  -- El commit bloquea primero la operación y luego las fuentes. Una repetición
  -- idempotente mantiene ese mismo orden, pero no retorna hasta revalidar la
  -- aprobación vigente bajo todos los locks de negocio.
  select * into v_existing
  from private.payroll_period_close_operations o
  where o.id = p_operation_id
  for update;
  v_existing_found := found;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  select r.revision into v_current_revision
  from private.payroll_source_revisions r
  where r.company_id = p_company_id
  for update;
  if v_current_revision is distinct from p_expected_source_revision then
    raise exception 'Los datos de Workera cambiaron durante el cierre. Vuelve a comprobarlos.'
      using errcode = '40001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'payroll-workbook|' || p_company_id::text || '|' || p_reporting_period_id::text,
      0
    )
  );

  select * into v_period
  from public.reporting_periods rp
  where rp.id = p_reporting_period_id
    and rp.company_id = p_company_id
  for update;
  if not found or v_period.status is distinct from p_expected_status then
    raise exception 'El período cambió de estado durante el cierre. Vuelve a comprobarlo.'
      using errcode = '40001';
  end if;
  if v_period.period_end <> (date_trunc('month', v_period.period_end)::date + 14)
     or v_period.period_start <> (
       (date_trunc('month', v_period.period_end)::date - 1) - interval '15 days'
     )::date then
    raise exception 'El cierre final exige el corte de pago exacto 16-15.' using errcode = '22023';
  end if;

  if p_storage_path is null or p_storage_path !~ (
    '^' || p_company_id::text || '/'
    || v_period.period_start::text || '_' || v_period.period_end::text
    || '/closed/' || p_reporting_period_id::text || '/' || p_operation_id::text || '[.]xlsx$'
  ) then
    raise exception 'La ruta privada del snapshot no corresponde a la operación.' using errcode = '22023';
  end if;

  select v.id into v_latest
  from public.payroll_workbook_versions v
  where v.company_id = p_company_id
    and v.reporting_period_id = p_reporting_period_id
    and v.status = 'ACCEPTED'
  order by v.version_number desc
  limit 1;
  if v_latest is distinct from p_expected_base_version_id then
    raise exception 'La pre-nómina aceptada cambió durante el cierre. Vuelve a comprobarla.'
      using errcode = '40001';
  end if;

  if not exists (
    select 1
    from private.payroll_workbook_source_attestations a
    where a.workbook_version_id = v_latest
      and a.company_id = p_company_id
      and a.source_revision = v_current_revision
  ) then
    raise exception 'La versión aceptada quedó obsoleta tras cambios en Workera. Vuelve a compararla y confirmarla.'
      using errcode = '40001';
  end if;

  if exists (
    select 1
    from public.payroll_workbook_conflicts c
    where c.company_id = p_company_id
      and c.reporting_period_id = p_reporting_period_id
      and c.resolved_at is null
  ) then
    raise exception 'Quedan conflictos Workera/RR. HH. sin resolver.' using errcode = '55000';
  end if;

  -- Esta lectura y su lock ocurren en la misma transacción que reserva la
  -- operación. El cotejo incluye tenant, período, base, revisión y digest.
  select a.id into v_approval_id
  from public.reporting_period_approvals a
  where a.company_id = p_company_id
    and a.reporting_period_id = p_reporting_period_id
    and a.accepted_workbook_version_id = p_expected_base_version_id
    and a.source_revision = p_expected_source_revision
    and a.readiness_sha256 = p_expected_readiness_sha256
    and a.invalidated_at is null
  for update;
  if not found then
    raise exception 'La aprobación de RR. HH. cambió durante el cierre. Vuelve a comprobarla.'
      using errcode = '40001';
  end if;

  if v_existing_found then
    if v_existing.actor_id = v_actor
       and v_existing.company_id = p_company_id
       and v_existing.reporting_period_id = p_reporting_period_id
       and v_existing.base_version_id = p_expected_base_version_id
       and v_existing.source_revision = p_expected_source_revision
       and v_existing.readiness_sha256 = p_expected_readiness_sha256
       and v_existing.content_sha256 = p_content_sha256
       and v_existing.file_size = p_file_size
       and v_existing.storage_path = p_storage_path
       and v_existing.status = 'PREPARED'
       and v_existing.expires_at > statement_timestamp() then
      return v_existing.id;
    end if;
    raise exception 'El identificador de cierre ya pertenece a otra operación.' using errcode = '23505';
  end if;

  insert into private.payroll_period_close_operations (
    id,
    company_id,
    reporting_period_id,
    actor_id,
    expected_status,
    base_version_id,
    source_revision,
    readiness_sha256,
    content_sha256,
    file_size,
    storage_path,
    mfa_aal,
    expires_at
  ) values (
    p_operation_id,
    p_company_id,
    p_reporting_period_id,
    v_actor,
    p_expected_status,
    v_latest,
    v_current_revision,
    p_expected_readiness_sha256,
    p_content_sha256,
    p_file_size,
    p_storage_path,
    auth.jwt() ->> 'aal',
    statement_timestamp() + interval '15 minutes'
  );

  return p_operation_id;
end;
$$;

revoke all on function public.prepare_payroll_period_close(
  uuid, uuid, uuid, public.reporting_period_status, uuid, bigint, text, text, integer, text
) from public, anon, service_role;
grant execute on function public.prepare_payroll_period_close(
  uuid, uuid, uuid, public.reporting_period_status, uuid, bigint, text, text, integer, text
) to authenticated;

comment on function public.prepare_payroll_period_close(
  uuid, uuid, uuid, public.reporting_period_status, uuid, bigint, text, text, integer, text
) is
  'Reserva por 15 minutos un cierre ADMIN_RRHH+MFA contra estado, base, revisión y digest de readiness aprobados por RR. HH.';

-- Defensa adicional: la inserción y el cambio PREPARED -> COMMITTED exigen
-- que siga activa la misma aprobación. Si falla durante commit, PostgreSQL
-- revierte también snapshot, período y auditoría de esa transacción.
create or replace function private.require_current_payroll_approval_for_close()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.status <> 'COMMITTED'
       or new.status is not distinct from old.status then
      return new;
    end if;
  end if;

  perform 1
  from public.reporting_period_approvals a
  where a.company_id = new.company_id
    and a.reporting_period_id = new.reporting_period_id
    and a.accepted_workbook_version_id = new.base_version_id
    and a.source_revision = new.source_revision
    and a.readiness_sha256 = new.readiness_sha256
    and a.invalidated_at is null
  for update;

  if not found then
    raise exception 'El cierre exige la aprobación RR. HH. vigente de esta versión, revisión y evidencia.'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function private.require_current_payroll_approval_for_close()
  from public, anon, authenticated, service_role;

drop trigger if exists payroll_close_operation_requires_current_approval
  on private.payroll_period_close_operations;
create trigger payroll_close_operation_requires_current_approval
  before insert or update of status on private.payroll_period_close_operations
  for each row execute function private.require_current_payroll_approval_for_close();
