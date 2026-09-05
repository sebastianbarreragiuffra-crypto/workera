-- pgTAP: el switch financiero del piloto contable exige MFA y conserva
-- autorización, estado y auditoría atómicos.
create extension if not exists pgtap;

begin;
select plan(8);

select ok(
  (select count(*)::integer
   from pg_catalog.regexp_matches(
     pg_get_functiondef(
       'public.platform_set_expense_accounting_pilot(uuid,boolean,text)'::regprocedure
     ),
     'can_manage_platform\(\)', 'g'
   )) = 2
  and pg_catalog.strpos(
    pg_get_functiondef(
      'public.platform_set_expense_accounting_pilot(uuid,boolean,text)'::regprocedure
    ),
    'enforce_mfa_for_privileged()'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef(
      'public.platform_set_expense_accounting_pilot(uuid,boolean,text)'::regprocedure
    ),
    'enforce_mfa_for_privileged()'
  ) < pg_catalog.strpos(
    pg_get_functiondef(
      'public.platform_set_expense_accounting_pilot(uuid,boolean,text)'::regprocedure
    ),
    'for update'
  ),
  'el RPC exige MFA antes del lock y revalida autorización después'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.platform_set_expense_accounting_pilot(uuid,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'anon',
    'public.platform_set_expense_accounting_pilot(uuid,boolean,text)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.platform_set_expense_accounting_pilot(uuid,boolean,text)',
    'EXECUTE'
  ),
  'el hardening conserva la ACL cerrada del RPC'
);

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  '85000000-0000-4000-8000-000000000001',
  'Piloto MFA 085', 'Piloto MFA 085 SpA', 'piloto-mfa-085',
  true, 'ONBOARDING', false
);
insert into public.profiles (id, display_name, role, active)
values (
  '85000000-0000-4000-8000-000000000101',
  'Owner Piloto MFA 085', null, true
);
insert into public.platform_memberships (user_id, role, active)
values ('85000000-0000-4000-8000-000000000101', 'OWNER', true);
update public.company_modules
set status = 'PILOT', enabled_at = pg_catalog.now(),
    enabled_by = '85000000-0000-4000-8000-000000000101',
    settings = pg_catalog.jsonb_set(
      settings, '{expense_accounting_export_enabled}', 'false'::jsonb, true
    )
where company_id = '85000000-0000-4000-8000-000000000001'
  and module_key = 'expenses';

set local role authenticated;
set local request.jwt.claim.sub = '85000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal1';
set local request.jwt.claims = '{"sub":"85000000-0000-4000-8000-000000000101","aal":"aal1"}';
select throws_ok(
  $$select public.platform_set_expense_accounting_pilot(
    '85000000-0000-4000-8000-000000000001', true,
    'Activación contable bloqueada sin segundo factor'
  )$$,
  'P0001', 'Esta operación requiere verificación de segundo factor (MFA).',
  'OWNER en AAL1 no puede activar el piloto contable'
);
reset role;
set local request.jwt.claims = '';

select ok(
  (select settings_version = 1
          and settings @> '{"expense_accounting_export_enabled": false}'::jsonb
   from public.company_modules
   where company_id = '85000000-0000-4000-8000-000000000001'
     and module_key = 'expenses'),
  'el rechazo AAL1 no muta settings ni su versión'
);
select is(
  (select count(*)::integer from public.platform_audit_log
   where company_id = '85000000-0000-4000-8000-000000000001'
     and action = 'company.expense_accounting_pilot.changed'),
  0,
  'el rechazo AAL1 no crea auditoría'
);

set local role authenticated;
set local request.jwt.claim.sub = '85000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"85000000-0000-4000-8000-000000000101","aal":"aal2"}';
select is(
  public.platform_set_expense_accounting_pilot(
    '85000000-0000-4000-8000-000000000001', true,
    'Activación contable autorizada con segundo factor'
  ),
  true,
  'OWNER en AAL2 activa el piloto contable'
);
reset role;
set local request.jwt.claims = '';

select ok(
  (select settings_version = 2
          and settings @> '{"expense_accounting_export_enabled": true}'::jsonb
   from public.company_modules
   where company_id = '85000000-0000-4000-8000-000000000001'
     and module_key = 'expenses'),
  'la activación AAL2 muta el flag e incrementa una versión'
);
select is(
  (select count(*)::integer from public.platform_audit_log
   where company_id = '85000000-0000-4000-8000-000000000001'
     and actor_id = '85000000-0000-4000-8000-000000000101'
     and action = 'company.expense_accounting_pilot.changed'
     and target_id = 'expenses:accounting'
     and metadata @> '{"previous_enabled": false, "enabled": true}'::jsonb
     and metadata ->> 'reason' = 'Activación contable autorizada con segundo factor'),
  1,
  'la activación AAL2 deja una auditoría completa y única'
);

select * from finish();
rollback;
