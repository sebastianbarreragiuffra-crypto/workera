-- pgTAP: profiles.active=false revoca autorización aunque el JWT siga válido.
create extension if not exists pgtap;

begin;
select plan(11);

insert into public.profiles (id, display_name, role, active, medical_license_approver) values
  ('93400000-0000-0000-0000-000000000001', 'Fixture activo', 'ADMIN_RRHH', true, true),
  ('93400000-0000-0000-0000-000000000002', 'Fixture desactivado', 'ADMIN_RRHH', false, true);

insert into public.employees (id, external_workera_id, first_name, last_name, display_name) values
  ('93400000-0000-0000-0000-000000000003', 'TEST-INACTIVE-ACCESS', 'Fixture', 'Empleado', 'Fixture Empleado');

insert into public.supporting_documents
  (id, employee_id, document_type, storage_path, mime_type, original_filename, uploaded_by)
values
  ('93400000-0000-0000-0000-000000000004',
   '93400000-0000-0000-0000-000000000003',
   'OTHER', 'test-only/inactive-access.pdf', 'application/pdf', 'inactive-access.pdf',
   '93400000-0000-0000-0000-000000000002');

set local role authenticated;
set local request.jwt.claim.sub = '93400000-0000-0000-0000-000000000001';

select is(
  public.current_user_role(),
  'ADMIN_RRHH'::public.app_role,
  'un profile activo conserva su rol'
);
select ok(public.is_corporate_user(), 'un profile activo sigue siendo usuario corporativo');
select ok(public.is_privileged_admin(), 'un ADMIN_RRHH activo conserva autorización privilegiada');
select ok(public.is_medical_license_approver(), 'el aprobador activo conserva su permiso especial');

set local request.jwt.claim.sub = '93400000-0000-0000-0000-000000000002';

select is(
  public.current_user_role(),
  null,
  'un profile desactivado pierde su rol aunque el JWT siga identificándolo'
);
select isnt(public.is_corporate_user(), true, 'un profile desactivado deja de ser usuario corporativo');
select isnt(public.is_privileged_admin(), true, 'un ADMIN_RRHH desactivado pierde privilegios');
select isnt(public.is_medical_license_approver(), true, 'un aprobador desactivado pierde el permiso especial');
select is((select count(*)::int from public.employees), 0, 'RLS oculta datos de negocio al profile desactivado');
select is((select count(*)::int from public.supporting_documents_metadata), 0, 'la vista security-definer no filtra metadata al autor desactivado');
select throws_ok(
  $$ insert into public.audit_log (actor_id, action, entity_type, entity_id)
     values ('93400000-0000-0000-0000-000000000002', 'inactive.attempt', 'profiles', gen_random_uuid()) $$,
  '42501',
  null,
  'un profile desactivado no puede insertar ruido en audit_log'
);

reset role;
select * from finish();
rollback;
