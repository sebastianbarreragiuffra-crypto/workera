-- pgTAP: ejecutar solo en una Supabase local aislada compatible con la rama.
create extension if not exists pgtap;

begin;
select plan(8);

select has_function(
  'private', 'prevent_registered_workforce_object_mutation', array[]::text[],
  'existe el guard físico de evidencia laboral'
);

select ok(
  pg_get_functiondef('private.prevent_registered_workforce_object_mutation()'::regprocedure)
    like '%tg_op <> ''INSERT''%'
  and pg_get_functiondef('private.prevent_registered_workforce_object_mutation()'::regprocedure)
    like '%new.owner_id is distinct from o.actor_id::text%',
  'el guard limita la excepción al INSERT inicial del actor y ruta reservados'
);

insert into public.profiles(id, display_name, role, active)
values ('10700000-0000-4000-8000-000000000001', 'RRHH ficticio 107', null, true);

insert into public.company_memberships(id, user_id, company_id, role, active)
values (
  '10700000-0000-4000-8000-000000000002',
  '10700000-0000-4000-8000-000000000001',
  '0a4c0000-0000-0000-0000-000000000001',
  'ADMIN_RRHH', true
);

insert into public.company_membership_roles(company_id, membership_id, role_id)
select
  '0a4c0000-0000-0000-0000-000000000001',
  '10700000-0000-4000-8000-000000000002',
  cr.id
from public.company_roles cr
where cr.company_id = '0a4c0000-0000-0000-0000-000000000001'
  and cr.code = 'HR_ADMIN';

insert into public.reporting_periods(
  id, company_id, period_start, period_end, status
) values (
  '10700000-0000-4000-8000-000000000010',
  '0a4c0000-0000-0000-0000-000000000001',
  date '2026-06-16', date '2026-07-15', 'OPEN'
);

update public.reporting_periods
set status = 'IN_REVIEW'
where id = '10700000-0000-4000-8000-000000000010';

insert into public.payroll_workbook_versions (
  id, company_id, reporting_period_id, period_start, period_end,
  version_number, status, schema_version, content_sha256, file_size,
  storage_path, general_reason, uploaded_by, accepted_by, accepted_at,
  source_revision
) values (
  '10700000-0000-4000-8000-000000000020',
  '0a4c0000-0000-0000-0000-000000000001',
  '10700000-0000-4000-8000-000000000010',
  date '2026-06-16', date '2026-07-15', 1, 'ACCEPTED',
  'GESTORA_PRENOMINA_2026_V2', repeat('a', 64), 1234,
  '0a4c0000-0000-0000-0000-000000000001/2026-06-16_2026-07-15/10700000-0000-4000-8000-000000000099.xlsx',
  'Base ficticia 107',
  '10700000-0000-4000-8000-000000000001',
  '10700000-0000-4000-8000-000000000001', clock_timestamp(),
  (select revision from private.payroll_source_revisions
   where company_id='0a4c0000-0000-0000-0000-000000000001')
);

insert into private.payroll_workbook_source_attestations (
  workbook_version_id, company_id, source_revision, attested_by
) values (
  '10700000-0000-4000-8000-000000000020',
  '0a4c0000-0000-0000-0000-000000000001',
  (select revision from private.payroll_source_revisions
   where company_id='0a4c0000-0000-0000-0000-000000000001'),
  '10700000-0000-4000-8000-000000000001'
);

select set_config(
  'test.source_revision_107',
  (select revision::text from private.payroll_source_revisions
   where company_id='0a4c0000-0000-0000-0000-000000000001'),
  true
);

set local role service_role;
set local request.jwt.claim.role = 'service_role';
select set_config(
  'gestora.payroll_ready_approval',
  '10700000-0000-4000-8000-000000000010',
  true
);
update public.reporting_periods
set status = 'READY_TO_CLOSE'
where id = '10700000-0000-4000-8000-000000000010';
reset role;

insert into public.reporting_period_approvals (
  company_id, reporting_period_id, approved_by,
  accepted_workbook_version_id, source_revision, readiness_sha256
) values (
  '0a4c0000-0000-0000-0000-000000000001',
  '10700000-0000-4000-8000-000000000010',
  '10700000-0000-4000-8000-000000000001',
  '10700000-0000-4000-8000-000000000020',
  current_setting('test.source_revision_107')::bigint,
  repeat('b', 64)
);

insert into private.payroll_period_close_operations (
  id, company_id, reporting_period_id, actor_id, expected_status,
  base_version_id, source_revision, content_sha256, file_size,
  storage_path, mfa_aal, expires_at
) values (
  '10700000-0000-4000-8000-000000000030',
  '0a4c0000-0000-0000-0000-000000000001',
  '10700000-0000-4000-8000-000000000010',
  '10700000-0000-4000-8000-000000000001', 'READY_TO_CLOSE',
  '10700000-0000-4000-8000-000000000020',
  (select revision from private.payroll_source_revisions
   where company_id='0a4c0000-0000-0000-0000-000000000001'),
  repeat('c', 64), 4321,
  '0a4c0000-0000-0000-0000-000000000001/2026-06-16_2026-07-15/closed/10700000-0000-4000-8000-000000000010/10700000-0000-4000-8000-000000000030.xlsx',
  'aal2', clock_timestamp() + interval '15 minutes'
);

select lives_ok(
  $$insert into storage.objects(
      id, bucket_id, name, owner_id, metadata, user_metadata
    ) values (
      '10700000-0000-4000-8000-000000000040',
      'payroll-workbooks',
      '0a4c0000-0000-0000-0000-000000000001/2026-06-16_2026-07-15/closed/10700000-0000-4000-8000-000000000010/10700000-0000-4000-8000-000000000030.xlsx',
      '10700000-0000-4000-8000-000000000001',
      '{"mimetype":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","size":4321}'::jsonb,
      jsonb_build_object(
        'artifact_kind', 'CLOSED_SNAPSHOT',
        'content_sha256', repeat('c', 64),
        'reporting_period_id', '10700000-0000-4000-8000-000000000010',
        'period_start', '2026-06-16',
        'period_end', '2026-07-15',
        'operation_id', '10700000-0000-4000-8000-000000000030',
        'base_version_id', '10700000-0000-4000-8000-000000000020',
        'source_revision', (select revision::text
          from private.payroll_source_revisions
          where company_id='0a4c0000-0000-0000-0000-000000000001')
      )
    )$$,
  'la subida inicial exacta de la reserva PREPARED está permitida'
);

select is(
  (select count(*) from storage.objects
   where id='10700000-0000-4000-8000-000000000040'),
  1::bigint,
  'el snapshot preparado queda registrado una sola vez'
);

select throws_ok(
  $$update storage.objects set metadata=metadata
    where id='10700000-0000-4000-8000-000000000040'$$,
  '42501', 'No se puede alterar evidencia laboral registrada.',
  'ni siquiera un UPDATE sin cambios puede sustituir el snapshot preparado'
);

select throws_ok(
  $$delete from storage.objects
    where id='10700000-0000-4000-8000-000000000040'$$,
  '42501', null,
  'el snapshot preparado no se puede borrar'
);

insert into private.payroll_period_close_operations (
  id, company_id, reporting_period_id, actor_id, expected_status,
  base_version_id, source_revision, content_sha256, file_size,
  storage_path, mfa_aal, expires_at
) values (
  '10700000-0000-4000-8000-000000000031',
  '0a4c0000-0000-0000-0000-000000000001',
  '10700000-0000-4000-8000-000000000010',
  '10700000-0000-4000-8000-000000000001', 'READY_TO_CLOSE',
  '10700000-0000-4000-8000-000000000020',
  (select revision from private.payroll_source_revisions
   where company_id='0a4c0000-0000-0000-0000-000000000001'),
  repeat('d', 64), 4321,
  '0a4c0000-0000-0000-0000-000000000001/2026-06-16_2026-07-15/closed/10700000-0000-4000-8000-000000000010/10700000-0000-4000-8000-000000000031.xlsx',
  'aal2', clock_timestamp() + interval '15 minutes'
);

select throws_ok(
  $$insert into storage.objects(
      id, bucket_id, name, owner_id, metadata, user_metadata
    ) values (
      '10700000-0000-4000-8000-000000000041',
      'payroll-workbooks',
      '0a4c0000-0000-0000-0000-000000000001/2026-06-16_2026-07-15/closed/10700000-0000-4000-8000-000000000010/10700000-0000-4000-8000-000000000031.xlsx',
      '10700000-0000-4000-8000-000000000009',
      '{"mimetype":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","size":4321}'::jsonb,
      jsonb_build_object(
        'artifact_kind', 'CLOSED_SNAPSHOT',
        'content_sha256', repeat('e', 64),
        'reporting_period_id', '10700000-0000-4000-8000-000000000010',
        'period_start', '2026-06-16',
        'period_end', '2026-07-15',
        'operation_id', '10700000-0000-4000-8000-000000000031',
        'base_version_id', '10700000-0000-4000-8000-000000000020',
        'source_revision', (select revision::text
          from private.payroll_source_revisions
          where company_id='0a4c0000-0000-0000-0000-000000000001')
      )
    )$$,
  '42501', 'No se puede mover un objeto sobre evidencia laboral registrada.',
  'otro actor no puede ocupar la ruta preparada'
);

select is(
  (select count(*) from storage.objects
   where id='10700000-0000-4000-8000-000000000041'),
  0::bigint,
  'la inserción de otro actor no deja objeto'
);

select * from finish();
rollback;
