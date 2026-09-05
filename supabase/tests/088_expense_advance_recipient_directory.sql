-- pgTAP GESTORA: directorio mínimo de destinatarios de anticipos.
create extension if not exists pgtap;

begin;
select plan(8);

select has_function(
  'public', 'list_expense_advance_recipients', array['uuid'],
  'existe el directorio financiero tenant-scoped'
);
select ok(
  has_function_privilege('authenticated', 'public.list_expense_advance_recipients(uuid)', 'EXECUTE'),
  'authenticated puede invocar el directorio'
);
select ok(
  not has_function_privilege('anon', 'public.list_expense_advance_recipients(uuid)', 'EXECUTE'),
  'anon no puede invocar el directorio'
);
select ok(
  not has_function_privilege('public', 'public.list_expense_advance_recipients(uuid)', 'EXECUTE'),
  'PUBLIC no puede invocar el directorio'
);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('f1000000-0000-0000-0000-000000000001', 'Directorio Uno', 'Directorio Uno SpA', 'directorio-uno', true, 'ONBOARDING', false),
  ('f1000000-0000-0000-0000-000000000002', 'Directorio Dos', 'Directorio Dos SpA', 'directorio-dos', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('f1000000-0000-0000-0000-000000000101', 'Finanzas Uno', null, true),
  ('f1000000-0000-0000-0000-000000000102', 'Persona Activa', null, true),
  ('f1000000-0000-0000-0000-000000000103', 'Sin Permiso', null, true),
  ('f1000000-0000-0000-0000-000000000104', 'Identidad Inactiva', null, false),
  ('f1000000-0000-0000-0000-000000000105', 'Finanzas Ajena', null, true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('f1000000-0000-0000-0000-000000000201', 'f1000000-0000-0000-0000-000000000101', 'f1000000-0000-0000-0000-000000000001', null, true),
  ('f1000000-0000-0000-0000-000000000202', 'f1000000-0000-0000-0000-000000000102', 'f1000000-0000-0000-0000-000000000001', null, true),
  ('f1000000-0000-0000-0000-000000000203', 'f1000000-0000-0000-0000-000000000103', 'f1000000-0000-0000-0000-000000000001', null, true),
  ('f1000000-0000-0000-0000-000000000204', 'f1000000-0000-0000-0000-000000000104', 'f1000000-0000-0000-0000-000000000001', null, true),
  ('f1000000-0000-0000-0000-000000000205', 'f1000000-0000-0000-0000-000000000105', 'f1000000-0000-0000-0000-000000000002', null, true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id in ('f1000000-0000-0000-0000-000000000201','f1000000-0000-0000-0000-000000000205') and cr.code = 'HR_ADMIN')
   or (cm.id in ('f1000000-0000-0000-0000-000000000202','f1000000-0000-0000-0000-000000000203','f1000000-0000-0000-0000-000000000204') and cr.code = 'PRODUCTION_SUPERVISOR');

update public.company_modules
set status = 'PILOT', enabled_at = pg_catalog.clock_timestamp()
where company_id in ('f1000000-0000-0000-0000-000000000001','f1000000-0000-0000-0000-000000000002')
  and module_key = 'expenses';

set local role authenticated;
set local request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000101';
select results_eq(
  $$select user_id, display_name from public.list_expense_advance_recipients('f1000000-0000-0000-0000-000000000001') order by user_id$$,
  $$values
    ('f1000000-0000-0000-0000-000000000101'::uuid, 'Finanzas Uno'::text),
    ('f1000000-0000-0000-0000-000000000102'::uuid, 'Persona Activa'::text),
    ('f1000000-0000-0000-0000-000000000103'::uuid, 'Sin Permiso'::text)$$,
  'finanzas ve solo identidades activas con membresía activa de su empresa'
);
select is(
  (select count(*)::integer from public.list_expense_advance_recipients('f1000000-0000-0000-0000-000000000001')),
  3,
  'la identidad inactiva y la otra empresa quedan fuera'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000103';
select throws_ok(
  $$select * from public.list_expense_advance_recipients('f1000000-0000-0000-0000-000000000001')$$,
  '42501', 'Tu rol no permite consultar destinatarios de anticipos.',
  'un miembro sin permiso financiero no accede al directorio'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'f1000000-0000-0000-0000-000000000105';
select throws_ok(
  $$select * from public.list_expense_advance_recipients('f1000000-0000-0000-0000-000000000001')$$,
  '42501', 'Tu rol no permite consultar destinatarios de anticipos.',
  'finanzas de otra empresa no cruza el tenant'
);
reset role;

select * from finish();
rollback;
