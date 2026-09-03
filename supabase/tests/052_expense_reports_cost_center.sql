-- pgTAP GESTORA Rendiciones: lectura de organization_units para etiquetar
-- centro de costo, sin ampliar permisos de escritura.
create extension if not exists pgtap;
begin;
select plan(10);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('ff000000-0000-0000-0000-000000000001', 'Gastos Centro Costo', 'Gastos Centro Costo SpA', 'gastos-centro-costo', true, 'ONBOARDING', false),
  ('ff000000-0000-0000-0000-000000000002', 'Gastos Centro Costo Ajena', 'Gastos Centro Costo Ajena SpA', 'gastos-centro-costo-ajena', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('ff000000-0000-0000-0000-000000000101', 'Platform CC', null, true),
  ('ff000000-0000-0000-0000-000000000102', 'Submitter CC', null, true),
  ('ff000000-0000-0000-0000-000000000103', 'Sin permisos CC', null, true),
  ('ff000000-0000-0000-0000-000000000104', 'Ajeno CC', null, true),
  ('ff000000-0000-0000-0000-000000000105', 'Manager CC', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('ff000000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('ff000000-0000-0000-0000-000000000201', 'ff000000-0000-0000-0000-000000000102', 'ff000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('ff000000-0000-0000-0000-000000000202', 'ff000000-0000-0000-0000-000000000103', 'ff000000-0000-0000-0000-000000000001', null, true),
  ('ff000000-0000-0000-0000-000000000203', 'ff000000-0000-0000-0000-000000000104', 'ff000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true),
  ('ff000000-0000-0000-0000-000000000204', 'ff000000-0000-0000-0000-000000000105', 'ff000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id = 'ff000000-0000-0000-0000-000000000201' and cr.code = 'PRODUCTION_SUPERVISOR')
   or (cm.id = 'ff000000-0000-0000-0000-000000000204' and cr.code = 'HR_ADMIN');

set local role authenticated;
set local request.jwt.claim.sub = 'ff000000-0000-0000-0000-000000000101';
select lives_ok($$select public.platform_set_company_module_status('ff000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$, 'se activa Rendiciones en la empresa propia');
reset role;

-- Unidad organizacional raíz que provision_company_control_plane ya crea
-- al insertar la empresa (mismo criterio que 047: la fila existe sin
-- sembrarla a mano).
select ok(
  exists(select 1 from public.organization_units where company_id = 'ff000000-0000-0000-0000-000000000001'),
  'la empresa propia ya tiene al menos una unidad organizacional raíz'
);

-- expenses.submit solo (PRODUCTION_SUPERVISOR): antes de esta migración no
-- podía leer organization_units; ahora sí, para poder elegir centro de
-- costo -- pero sigue sin poder escribir.
set local role authenticated;
set local request.jwt.claim.sub = 'ff000000-0000-0000-0000-000000000102';
select ok(
  (select count(*)::int from public.organization_units where company_id = 'ff000000-0000-0000-0000-000000000001') > 0,
  'expenses.submit ahora ve las unidades organizacionales de su empresa'
);
select throws_ok(
  $$update public.organization_units set name = 'Hackeado' where company_id = 'ff000000-0000-0000-0000-000000000001'$$,
  '42501', null,
  'expenses.submit sigue sin poder escribir organization_units (solo lectura)'
);
reset role;

-- La otra rama del OR agregado (expenses.manage, vía HR_ADMIN) también
-- concede lectura -- si un refactor futuro la elimina por error, esta
-- aserción debe fallar.
set local role authenticated;
set local request.jwt.claim.sub = 'ff000000-0000-0000-0000-000000000105';
select ok(
  (select count(*)::int from public.organization_units where company_id = 'ff000000-0000-0000-0000-000000000001') > 0,
  'expenses.manage (HR_ADMIN) también ve las unidades organizacionales de su empresa'
);
reset role;

-- Un miembro sin NINGÚN permiso de Rendiciones ni de control plane no ve
-- nada.
set local role authenticated;
set local request.jwt.claim.sub = 'ff000000-0000-0000-0000-000000000103';
select is(
  (select count(*)::int from public.organization_units where company_id = 'ff000000-0000-0000-0000-000000000001'),
  0, 'un miembro sin expenses.submit/manage ni organization.view no ve unidades organizacionales'
);
reset role;

-- Alguien de otra empresa (aunque tenga permisos plenos ahí) no ve las
-- unidades organizacionales de esta empresa.
set local role authenticated;
set local request.jwt.claim.sub = 'ff000000-0000-0000-0000-000000000104';
select is(
  (select count(*)::int from public.organization_units where company_id = 'ff000000-0000-0000-0000-000000000001'),
  0, 'un usuario de otra empresa no ve las unidades organizacionales ajenas'
);
reset role;

-- El propio submitter puede etiquetar su rendición en borrador con un
-- centro de costo -- confirma que la columna, ya otorgada desde EX-1, sigue
-- funcionando end-to-end junto con la nueva visibilidad de lectura.
set local role authenticated;
set local request.jwt.claim.sub = 'ff000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title)
values ('ff000000-0000-0000-0000-000000000301', 'ff000000-0000-0000-0000-000000000001', 'ff000000-0000-0000-0000-000000000102', 'Viaje con centro de costo');
select lives_ok(
  format(
    $$update public.expense_reports set organization_unit_id = %L where id = 'ff000000-0000-0000-0000-000000000301'$$,
    (select id from public.organization_units where company_id = 'ff000000-0000-0000-0000-000000000001' limit 1)
  ),
  'el submitter etiqueta su borrador con un centro de costo real de su empresa'
);
select ok(
  (select organization_unit_id from public.expense_reports where id = 'ff000000-0000-0000-0000-000000000301') is not null,
  'el centro de costo queda guardado en la rendición'
);
reset role;

-- No se puede etiquetar con un centro de costo de OTRA empresa -- la FK
-- compuesta (company_id, organization_unit_id) de expense_reports (EX-1) ya
-- lo impedía antes de esta migración; se reconfirma que sigue vigente.
set local role authenticated;
set local request.jwt.claim.sub = 'ff000000-0000-0000-0000-000000000102';
select throws_ok(
  format(
    $$update public.expense_reports set organization_unit_id = %L where id = 'ff000000-0000-0000-0000-000000000301'$$,
    (select id from public.organization_units where company_id = 'ff000000-0000-0000-0000-000000000002' limit 1)
  ),
  '23503', null,
  'no se puede etiquetar con un centro de costo de otra empresa (FK compuesta)'
);
reset role;

select * from finish();
rollback;
