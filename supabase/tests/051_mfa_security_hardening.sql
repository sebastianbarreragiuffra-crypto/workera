-- pgTAP: cobertura extremo a extremo de las guardas corregidas en 050 para
-- las seis superficies sensibles del control plane que modifican estado.
create extension if not exists pgtap;

begin;
select plan(7);

insert into public.profiles (id, display_name, role, active)
values (
  '97000000-0000-0000-0000-000000000101',
  'Usuario sin plataforma MFA',
  'SUPER_ADMIN',
  true
);

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000101';
set local request.jwt.claim.aal = 'aal2';

select is(
  public.can_manage_platform(),
  false,
  'sin membresía de plataforma la autorización devuelve false, nunca null'
);

select throws_ok(
  $$select public.platform_create_company('Sin permiso MFA', 'sin-permiso-mfa')$$,
  '42501', 'Se requiere un OWNER o ADMIN activo de la plataforma.',
  'una identidad sin plataforma no puede crear empresas'
);

select throws_ok(
  $$select public.platform_assign_company_role(
      '97000000-0000-0000-0000-000000000201',
      '97000000-0000-0000-0000-000000000202')$$,
  '42501', 'Se requiere un OWNER o ADMIN activo de la plataforma.',
  'una identidad sin plataforma no puede asignar roles empresariales'
);

select throws_ok(
  $$select public.platform_set_company_module_status(
      '97000000-0000-0000-0000-000000000001',
      'expenses',
      'PILOT'::public.company_module_status)$$,
  '42501', 'Se requiere un OWNER o ADMIN activo de la plataforma.',
  'una identidad sin plataforma no puede cambiar módulos'
);

select throws_ok(
  $$select public.platform_set_onboarding_step_completed(
      '97000000-0000-0000-0000-000000000001',
      'company_profile',
      true)$$,
  '42501', 'Se requiere un OWNER o ADMIN activo de la plataforma.',
  'una identidad sin plataforma no puede completar onboarding'
);

select throws_ok(
  $$select public.platform_create_company_invitation(
      '97000000-0000-0000-0000-000000000001',
      'sin-permiso@example.com',
      '97000000-0000-0000-0000-000000000203')$$,
  '42501', 'Se requiere un OWNER o ADMIN activo de la plataforma.',
  'una identidad sin plataforma no puede crear invitaciones'
);

select throws_ok(
  $$select public.platform_create_organization_unit(
      '97000000-0000-0000-0000-000000000001',
      '97000000-0000-0000-0000-000000000204',
      'NO_ACCESS',
      'Sin acceso',
      'TEAM'::public.organization_unit_type,
      0)$$,
  '42501', 'Se requiere un OWNER o ADMIN activo de la plataforma.',
  'una identidad sin plataforma no puede crear unidades'
);

reset role;
select * from finish();
rollback;
