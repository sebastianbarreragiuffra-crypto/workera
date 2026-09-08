-- Ejecutar únicamente sobre una instancia aislada con todas las migraciones
-- de esta rama. Este test no debe apuntar a la Supabase local compartida.
create extension if not exists pgtap;

begin;
select plan(22);

select has_column(
  'private', 'payroll_period_close_operations', 'readiness_sha256',
  'la reserva conserva el digest de readiness que aprobó RR. HH.'
);

select has_function(
  'public', 'prepare_payroll_period_close',
  array[
    'uuid', 'uuid', 'uuid', 'reporting_period_status', 'uuid', 'bigint',
    'text', 'text', 'integer', 'text'
  ],
  'prepare exige el digest además de revisión, base y snapshot'
);

select ok(
  to_regprocedure(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,integer,text)'
  ) is null,
  'la firma antigua sin digest fue eliminada y no queda como bypass'
);

select is(
  (
    select count(*)::integer
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'prepare_payroll_period_close'
  ),
  1,
  'prepare expone un único overload'
);

select ok(
  (
    select p.prosecdef
      and p.provolatile = 'v'
      and p.proconfig[1] = 'search_path=""'
    from pg_catalog.pg_proc p
    where p.oid = (
      'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,text,integer,text)'
    )::regprocedure
  ),
  'prepare conserva SECURITY DEFINER, VOLATILE y search_path vacío'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,text,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,text,integer,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,text,integer,text)',
    'EXECUTE'
  ),
  'solo authenticated puede invocar prepare y queda sujeto a sus gates internos'
);

select ok(
  lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,text,integer,text)'::regprocedure
  )) like '%p_expected_readiness_sha256 is null%p_expected_readiness_sha256 !~ ''^[a-f0-9]{64}$''%',
  'prepare rechaza un digest ausente o que no sea lower-hex SHA-256'
);

select ok(
  lower(pg_get_functiondef(
    'public.prepare_payroll_period_close(uuid,uuid,uuid,public.reporting_period_status,uuid,bigint,text,text,integer,text)'::regprocedure
  )) like (
    '%from public.reporting_period_approvals a%a.company_id = p_company_id%'
    || 'a.reporting_period_id = p_reporting_period_id%'
    || 'a.accepted_workbook_version_id = p_expected_base_version_id%'
    || 'a.source_revision = p_expected_source_revision%'
    || 'a.readiness_sha256 = p_expected_readiness_sha256%'
    || 'a.invalidated_at is null%for update%'
  ),
  'prepare bloquea y coteja la aprobación activa exacta dentro de la transacción'
);

select ok(
  lower(pg_get_functiondef(
    'private.require_current_payroll_approval_for_close()'::regprocedure
  )) like '%a.readiness_sha256 = new.readiness_sha256%a.invalidated_at is null%for update%',
  'el guard de defensa también liga el digest y bloquea la aprobación activa'
);

select ok(
  lower(pg_get_triggerdef(
    (
      select t.oid
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private'
        and c.relname = 'payroll_period_close_operations'
        and t.tgname = 'payroll_close_operation_requires_current_approval'
        and not t.tgisinternal
    ),
    true
  )) like '%before insert or update of status%',
  'el guard se ejecuta tanto al reservar como al pasar a COMMITTED'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'payroll_workbooks_storage_read'
  ),
  'Storage no permite saltarse la validación de padrón descargando XLSX directamente'
);

-- Fixture enteramente ficticio sobre un período anterior a required_from de
-- la sincronización; así la prueba se concentra en el contrato de aprobación.
insert into public.profiles(id, display_name, role, active)
values ('11300000-0000-4000-8000-000000000001', 'RRHH ficticio 113', null, true);

insert into public.company_memberships(id, user_id, company_id, role, active)
values (
  '11300000-0000-4000-8000-000000000002',
  '11300000-0000-4000-8000-000000000001',
  '0a4c0000-0000-0000-0000-000000000001',
  'ADMIN_RRHH', true
);

insert into public.company_membership_roles(company_id, membership_id, role_id)
select
  '0a4c0000-0000-0000-0000-000000000001',
  '11300000-0000-4000-8000-000000000002',
  cr.id
from public.company_roles cr
where cr.company_id = '0a4c0000-0000-0000-0000-000000000001'
  and cr.code = 'HR_ADMIN';

insert into public.reporting_periods(
  id, company_id, period_start, period_end, status
) values (
  '11300000-0000-4000-8000-000000000010',
  '0a4c0000-0000-0000-0000-000000000001',
  date '2025-01-16', date '2025-02-15', 'OPEN'
);

update public.reporting_periods
set status = 'IN_REVIEW'
where id = '11300000-0000-4000-8000-000000000010';

insert into public.payroll_workbook_versions (
  id, company_id, reporting_period_id, period_start, period_end,
  version_number, status, schema_version, content_sha256, file_size,
  storage_path, general_reason, uploaded_by, accepted_by, accepted_at,
  source_revision
) values (
  '11300000-0000-4000-8000-000000000020',
  '0a4c0000-0000-0000-0000-000000000001',
  '11300000-0000-4000-8000-000000000010',
  date '2025-01-16', date '2025-02-15', 1, 'ACCEPTED',
  'GESTORA_PRENOMINA_2026_V2', repeat('a', 64), 1234,
  '0a4c0000-0000-0000-0000-000000000001/2025-01-16_2025-02-15/11300000-0000-4000-8000-000000000099.xlsx',
  'Base ficticia 113',
  '11300000-0000-4000-8000-000000000001',
  '11300000-0000-4000-8000-000000000001', clock_timestamp(),
  (select revision from private.payroll_source_revisions
   where company_id = '0a4c0000-0000-0000-0000-000000000001')
);

insert into private.payroll_workbook_source_attestations (
  workbook_version_id, company_id, source_revision, attested_by
) values (
  '11300000-0000-4000-8000-000000000020',
  '0a4c0000-0000-0000-0000-000000000001',
  (select revision from private.payroll_source_revisions
   where company_id = '0a4c0000-0000-0000-0000-000000000001'),
  '11300000-0000-4000-8000-000000000001'
);

select set_config(
  'test.source_revision_113',
  (select revision::text
   from private.payroll_source_revisions
   where company_id = '0a4c0000-0000-0000-0000-000000000001'),
  true
);

set local request.jwt.claim.role = 'service_role';
select set_config(
  'gestora.payroll_ready_approval',
  '11300000-0000-4000-8000-000000000010',
  true
);
update public.reporting_periods
set status = 'READY_TO_CLOSE'
where id = '11300000-0000-4000-8000-000000000010';

insert into public.reporting_period_approvals (
  company_id, reporting_period_id, approved_by,
  accepted_workbook_version_id, source_revision, readiness_sha256
) values (
  '0a4c0000-0000-0000-0000-000000000001',
  '11300000-0000-4000-8000-000000000010',
  '11300000-0000-4000-8000-000000000001',
  '11300000-0000-4000-8000-000000000020',
  current_setting('test.source_revision_113')::bigint,
  repeat('b', 64)
);

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '11300000-0000-4000-8000-000000000001';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"11300000-0000-4000-8000-000000000001","aal":"aal2","role":"authenticated"}';

select throws_ok(
  $$select public.prepare_payroll_period_close(
    '11300000-0000-4000-8000-000000000030',
    '0a4c0000-0000-0000-0000-000000000001',
    '11300000-0000-4000-8000-000000000010',
    'READY_TO_CLOSE',
    '11300000-0000-4000-8000-000000000020',
    current_setting('test.source_revision_113')::bigint,
    repeat('A', 64), repeat('c', 64), 4321,
    '0a4c0000-0000-0000-0000-000000000001/2025-01-16_2025-02-15/closed/11300000-0000-4000-8000-000000000010/11300000-0000-4000-8000-000000000030.xlsx'
  )$$,
  '22023', null,
  'un digest que no sea lower-hex SHA-256 se rechaza antes de reservar'
);

select throws_ok(
  $$select public.prepare_payroll_period_close(
    '11300000-0000-4000-8000-000000000030',
    '0a4c0000-0000-0000-0000-000000000001',
    '11300000-0000-4000-8000-000000000010',
    'READY_TO_CLOSE',
    '11300000-0000-4000-8000-000000000020',
    current_setting('test.source_revision_113')::bigint,
    repeat('d', 64), repeat('c', 64), 4321,
    '0a4c0000-0000-0000-0000-000000000001/2025-01-16_2025-02-15/closed/11300000-0000-4000-8000-000000000010/11300000-0000-4000-8000-000000000030.xlsx'
  )$$,
  '40001', null,
  'un digest válido pero distinto del aprobado se rechaza'
);

select is(
  public.prepare_payroll_period_close(
    '11300000-0000-4000-8000-000000000030',
    '0a4c0000-0000-0000-0000-000000000001',
    '11300000-0000-4000-8000-000000000010',
    'READY_TO_CLOSE',
    '11300000-0000-4000-8000-000000000020',
    current_setting('test.source_revision_113')::bigint,
    repeat('b', 64), repeat('c', 64), 4321,
    '0a4c0000-0000-0000-0000-000000000001/2025-01-16_2025-02-15/closed/11300000-0000-4000-8000-000000000010/11300000-0000-4000-8000-000000000030.xlsx'
  ),
  '11300000-0000-4000-8000-000000000030'::uuid,
  'el digest exactamente aprobado permite crear la reserva'
);

select is(
  (select readiness_sha256
   from private.payroll_period_close_operations
   where id = '11300000-0000-4000-8000-000000000030'),
  repeat('b', 64),
  'la operación persiste el digest aprobado'
);

select is(
  public.prepare_payroll_period_close(
    '11300000-0000-4000-8000-000000000030',
    '0a4c0000-0000-0000-0000-000000000001',
    '11300000-0000-4000-8000-000000000010',
    'READY_TO_CLOSE',
    '11300000-0000-4000-8000-000000000020',
    current_setting('test.source_revision_113')::bigint,
    repeat('b', 64), repeat('c', 64), 4321,
    '0a4c0000-0000-0000-0000-000000000001/2025-01-16_2025-02-15/closed/11300000-0000-4000-8000-000000000010/11300000-0000-4000-8000-000000000030.xlsx'
  ),
  '11300000-0000-4000-8000-000000000030'::uuid,
  'la repetición exacta continúa siendo idempotente'
);

select is(
  (select count(*) from private.payroll_period_close_operations
   where id = '11300000-0000-4000-8000-000000000030'),
  1::bigint,
  'la repetición idempotente no duplica la reserva'
);

reset role;
update public.reporting_period_approvals
set invalidated_at = clock_timestamp(),
    invalidation_reason = 'Fixture invalida digest A'
where reporting_period_id = '11300000-0000-4000-8000-000000000010'
  and invalidated_at is null;

set local role authenticated;
select throws_ok(
  $$select public.prepare_payroll_period_close(
    '11300000-0000-4000-8000-000000000030',
    '0a4c0000-0000-0000-0000-000000000001',
    '11300000-0000-4000-8000-000000000010',
    'READY_TO_CLOSE',
    '11300000-0000-4000-8000-000000000020',
    current_setting('test.source_revision_113')::bigint,
    repeat('b', 64), repeat('c', 64), 4321,
    '0a4c0000-0000-0000-0000-000000000001/2025-01-16_2025-02-15/closed/11300000-0000-4000-8000-000000000010/11300000-0000-4000-8000-000000000030.xlsx'
  )$$,
  '40001', null,
  'invalidar la aprobación bloquea incluso el retry de una reserva existente'
);

reset role;
insert into public.reporting_period_approvals (
  company_id, reporting_period_id, approved_by,
  accepted_workbook_version_id, source_revision, readiness_sha256
) values (
  '0a4c0000-0000-0000-0000-000000000001',
  '11300000-0000-4000-8000-000000000010',
  '11300000-0000-4000-8000-000000000001',
  '11300000-0000-4000-8000-000000000020',
  current_setting('test.source_revision_113')::bigint,
  repeat('e', 64)
);

set local role authenticated;
select throws_ok(
  $$select public.prepare_payroll_period_close(
    '11300000-0000-4000-8000-000000000030',
    '0a4c0000-0000-0000-0000-000000000001',
    '11300000-0000-4000-8000-000000000010',
    'READY_TO_CLOSE',
    '11300000-0000-4000-8000-000000000020',
    current_setting('test.source_revision_113')::bigint,
    repeat('e', 64), repeat('c', 64), 4321,
    '0a4c0000-0000-0000-0000-000000000001/2025-01-16_2025-02-15/closed/11300000-0000-4000-8000-000000000010/11300000-0000-4000-8000-000000000030.xlsx'
  )$$,
  '23505', null,
  'un operation_id ligado al digest A no puede reutilizarse con el digest B'
);

select is(
  public.prepare_payroll_period_close(
    '11300000-0000-4000-8000-000000000031',
    '0a4c0000-0000-0000-0000-000000000001',
    '11300000-0000-4000-8000-000000000010',
    'READY_TO_CLOSE',
    '11300000-0000-4000-8000-000000000020',
    current_setting('test.source_revision_113')::bigint,
    repeat('e', 64), repeat('f', 64), 4321,
    '0a4c0000-0000-0000-0000-000000000001/2025-01-16_2025-02-15/closed/11300000-0000-4000-8000-000000000010/11300000-0000-4000-8000-000000000031.xlsx'
  ),
  '11300000-0000-4000-8000-000000000031'::uuid,
  'una nueva reserva sí puede ligarse a la reaprobación B'
);

select is(
  (select readiness_sha256
   from private.payroll_period_close_operations
   where id = '11300000-0000-4000-8000-000000000031'),
  repeat('e', 64),
  'la nueva reserva queda ligada al digest B'
);

reset role;
update public.reporting_period_approvals
set invalidated_at = clock_timestamp(),
    invalidation_reason = 'Fixture invalida digest B'
where reporting_period_id = '11300000-0000-4000-8000-000000000010'
  and invalidated_at is null;

select throws_ok(
  $$update private.payroll_period_close_operations
    set status = 'COMMITTED',
        committed_at = clock_timestamp(),
        snapshot_version_id = '11300000-0000-4000-8000-000000000020'
    where id = '11300000-0000-4000-8000-000000000031'$$,
  '55000', null,
  'una reserva no puede pasar a COMMITTED después de invalidar su aprobación'
);

select * from finish();
rollback;
