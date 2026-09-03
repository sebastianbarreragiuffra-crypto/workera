-- pgTAP GESTORA EX-7: anticipos y fondos por rendir.
create extension if not exists pgtap;

begin;
select plan(35);

select has_table('public', 'expense_advances', 'existe la tabla de anticipos');
select has_column('public', 'expense_reports', 'advance_id', 'la rendición puede vincularse a un anticipo');
select has_function('public', 'grant_expense_advance', array['uuid','uuid','numeric','text','text'], 'existe RPC de otorgamiento');
select has_function('public', 'link_expense_report_to_advance', array['uuid','uuid'], 'existe RPC de vinculación');
select has_function('public', 'settle_expense_advance', array['uuid'], 'existe RPC de cierre');
select has_function('public', 'cancel_expense_advance', array['uuid'], 'existe RPC de cancelación');
select ok(has_function_privilege('authenticated', 'public.grant_expense_advance(uuid,uuid,numeric,text,text)', 'EXECUTE'), 'authenticated puede otorgar anticipos');
select ok(not has_function_privilege('anon', 'public.grant_expense_advance(uuid,uuid,numeric,text,text)', 'EXECUTE'), 'anon no puede otorgar anticipos');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('ee000000-0000-0000-0000-000000000001', 'Gastos Anticipos', 'Gastos Anticipos SpA', 'gastos-anticipos', true, 'ONBOARDING', false),
  ('ee000000-0000-0000-0000-000000000002', 'Gastos Anticipos Ajeno', 'Gastos Anticipos Ajeno SpA', 'gastos-anticipos-ajeno', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('ee000000-0000-0000-0000-000000000101', 'Platform EX7', null, true),
  ('ee000000-0000-0000-0000-000000000102', 'Empleado A EX7', null, true),
  ('ee000000-0000-0000-0000-000000000103', 'Finanzas EX7', null, true),
  ('ee000000-0000-0000-0000-000000000104', 'Empleado B EX7', null, true),
  ('ee000000-0000-0000-0000-000000000105', 'Ajeno EX7', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('ee000000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('ee000000-0000-0000-0000-000000000201', 'ee000000-0000-0000-0000-000000000102', 'ee000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('ee000000-0000-0000-0000-000000000202', 'ee000000-0000-0000-0000-000000000103', 'ee000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('ee000000-0000-0000-0000-000000000203', 'ee000000-0000-0000-0000-000000000104', 'ee000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('ee000000-0000-0000-0000-000000000204', 'ee000000-0000-0000-0000-000000000105', 'ee000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id in ('ee000000-0000-0000-0000-000000000201','ee000000-0000-0000-0000-000000000203') and cr.code = 'PRODUCTION_SUPERVISOR')
   or (cm.id in ('ee000000-0000-0000-0000-000000000202','ee000000-0000-0000-0000-000000000204') and cr.code = 'HR_ADMIN');

set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000101';
select lives_ok($$select public.platform_set_company_module_status('ee000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$, 'se activa Rendiciones en la empresa propia');
reset role;

-- Un supervisor con solo expenses.submit no puede otorgar anticipos.
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.grant_expense_advance('ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000104', 50000, 'CLP', 'Viaje a terreno')$$,
  '42501', 'Tu rol no permite otorgar anticipos.',
  'expenses.submit por sí solo no habilita otorgar anticipos'
);
reset role;

-- Finanzas otorga un anticipo CLP a Empleado A, otro CLP a Empleado B, y uno
-- USD a Empleado A -- y falla al intentar otorgar a alguien de otra empresa.
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000103';
select lives_ok(
  $$select public.grant_expense_advance('ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000102', 100000, 'CLP', 'Anticipo viaje Santiago')$$,
  'finanzas otorga un anticipo CLP a Empleado A'
);
select lives_ok(
  $$select public.grant_expense_advance('ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000104', 60000, 'CLP', 'Anticipo caja chica')$$,
  'finanzas otorga un anticipo CLP a Empleado B'
);
select lives_ok(
  $$select public.grant_expense_advance('ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000102', 200, 'USD', 'Anticipo viaje EE.UU.')$$,
  'finanzas otorga un anticipo USD a Empleado A'
);
select throws_ok(
  $$select public.grant_expense_advance('ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000105', 50000, 'CLP', 'No debería otorgarse')$$,
  '23503', 'La persona destinataria no es miembro activo de esta empresa.',
  'no se puede otorgar un anticipo a alguien de otra empresa'
);
reset role;

-- Conserva los IDs generados por grant_expense_advance fuera de RLS. El
-- submitter no puede leer el anticipo de otra persona (correcto), pero el
-- test necesita su ID para comprobar que el RPC también rechaza vincularlo.
create temporary table expense_advance_fixture_ids as
select id, recipient_id, currency_code
from public.expense_advances;
grant select on expense_advance_fixture_ids to authenticated;

-- Empleado A crea una rendición en borrador (misma empresa/moneda CLP) y
-- vincula su anticipo CLP -- pero no puede vincular el anticipo CLP de
-- Empleado B, ni su propio anticipo USD contra una rendición CLP.
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title, currency_code)
values ('ee000000-0000-0000-0000-000000000301', 'ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000102', 'Viaje Santiago', 'CLP');

select throws_ok(
  format(
    $$select public.link_expense_report_to_advance('ee000000-0000-0000-0000-000000000301', %L)$$,
    (select id from pg_temp.expense_advance_fixture_ids where recipient_id = 'ee000000-0000-0000-0000-000000000104')
  ),
  '42501', 'Solo puedes vincular un anticipo otorgado a la persona que envía esta rendición.',
  'no se puede vincular el anticipo de otra persona'
);
select throws_ok(
  format(
    $$select public.link_expense_report_to_advance('ee000000-0000-0000-0000-000000000301', %L)$$,
    (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102' and currency_code = 'USD')
  ),
  '23514', 'La moneda de la rendición debe coincidir con la del anticipo.',
  'no se puede vincular un anticipo en otra moneda'
);
select lives_ok(
  format(
    $$select public.link_expense_report_to_advance('ee000000-0000-0000-0000-000000000301', %L)$$,
    (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102' and currency_code = 'CLP')
  ),
  'Empleado A vincula su propio anticipo CLP a su rendición en borrador'
);
select is(
  (select advance_id from public.expense_reports where id = 'ee000000-0000-0000-0000-000000000301'),
  (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102' and currency_code = 'CLP'),
  'la rendición queda vinculada al anticipo correcto'
);
select throws_ok(
  $$update public.expense_reports set advance_id = null where id = 'ee000000-0000-0000-0000-000000000301'$$,
  '42501', null,
  'el navegador no puede tocar advance_id con un UPDATE directo (sin GRANT de columna)'
);

-- Deriva de moneda después de vincular: currency_code sigue siendo editable
-- en borrador -- submit_expense_report() debe atajarlo, no solo el momento
-- de vincular.
insert into public.expense_reports (id, company_id, submitted_by, title, currency_code)
values ('ee000000-0000-0000-0000-000000000302', 'ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000102', 'Compra materiales', 'CLP');
insert into public.expense_items (id, company_id, report_id, expense_date, description, net_amount, currency_code)
values ('ee000000-0000-0000-0000-000000000402', 'ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000302', current_date, 'Materiales varios', 30000, 'CLP');
select lives_ok(
  format(
    $$select public.link_expense_report_to_advance('ee000000-0000-0000-0000-000000000302', %L)$$,
    (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102' and currency_code = 'CLP')
  ),
  'se vincula un segundo reporte al mismo anticipo CLP'
);
select lives_ok(
  $$update public.expense_reports set currency_code = 'USD' where id = 'ee000000-0000-0000-0000-000000000302'$$,
  'currency_code de un borrador propio sigue siendo editable directo (columna otorgada)'
);
select lives_ok(
  $$update public.expense_items set currency_code = 'USD' where id = 'ee000000-0000-0000-0000-000000000402'$$,
  'se actualiza también el ítem, para no chocar con el chequeo de moneda por ítem'
);
select throws_ok(
  $$select public.submit_expense_report('ee000000-0000-0000-0000-000000000302')$$,
  '23514', 'La moneda de la rendición ya no coincide con la del anticipo vinculado -- corrige la moneda o desvincula el anticipo antes de enviar.',
  'submit_expense_report bloquea la deriva de moneda contra el anticipo vinculado'
);
select lives_ok(
  $$select public.link_expense_report_to_advance('ee000000-0000-0000-0000-000000000302', null)$$,
  'se puede desvincular en borrador para poder corregir y reintentar'
);
reset role;

-- Anticipo USD vinculado a una rendición que termina RECHAZADA: el anticipo
-- no debe quedar atrapado -- se puede desvincular pese a no estar en
-- borrador, y luego sí se puede cancelar.
insert into public.expense_reports (id, company_id, submitted_by, title, currency_code)
values ('ee000000-0000-0000-0000-000000000303', 'ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000102', 'Viaje EE.UU.', 'USD');
insert into public.expense_items (id, company_id, report_id, expense_date, description, net_amount, currency_code)
values ('ee000000-0000-0000-0000-000000000403', 'ee000000-0000-0000-0000-000000000001', 'ee000000-0000-0000-0000-000000000303', current_date, 'Hotel', 150, 'USD');

set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000102';
select lives_ok(
  format(
    $$select public.link_expense_report_to_advance('ee000000-0000-0000-0000-000000000303', %L)$$,
    (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102' and currency_code = 'USD')
  ),
  'se vincula el anticipo USD a la rendición USD'
);
select lives_ok($$select public.submit_expense_report('ee000000-0000-0000-0000-000000000303')$$, 'se envía la rendición USD a revisión');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000103';
select lives_ok(
  $$select public.decide_expense_report('ee000000-0000-0000-0000-000000000303', 'REJECTED', 'Falta autorización previa del viaje')$$,
  'finanzas rechaza la rendición USD'
);
select throws_ok(
  format(
    $$select public.cancel_expense_advance(%L)$$,
    (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102' and currency_code = 'USD')
  ),
  '23514', 'Este anticipo ya tiene rendiciones vinculadas -- ciérralo en vez de cancelarlo.',
  'el anticipo USD sigue sin poder cancelarse mientras el rechazo no se desvincule'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000102';
select lives_ok(
  $$select public.link_expense_report_to_advance('ee000000-0000-0000-0000-000000000303', null)$$,
  'una rendición RECHAZADA sí puede desvincularse (no quedó atrapada como con la versión anterior del RPC)'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000103';
select lives_ok(
  format(
    $$select public.cancel_expense_advance(%L)$$,
    (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102' and currency_code = 'USD')
  ),
  'una vez desvinculado, el anticipo USD ya se puede cancelar'
);
reset role;

-- Un anticipo con rendición vinculada no se puede cancelar, solo cerrar; uno
-- sin rendiciones vinculadas sí se puede cancelar.
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000103';
select throws_ok(
  format(
    $$select public.cancel_expense_advance(%L)$$,
    (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102' and currency_code = 'CLP')
  ),
  '23514', 'Este anticipo ya tiene rendiciones vinculadas -- ciérralo en vez de cancelarlo.',
  'no se cancela un anticipo con rendiciones vinculadas'
);
select lives_ok(
  format(
    $$select public.cancel_expense_advance(%L)$$,
    (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000104')
  ),
  'se cancela un anticipo sin rendiciones vinculadas'
);
select lives_ok(
  format(
    $$select public.settle_expense_advance(%L)$$,
    (select id from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102' and currency_code = 'CLP')
  ),
  'finanzas cierra el anticipo con rendición vinculada'
);
reset role;

-- RLS: el destinatario ve su propio anticipo; alguien de otra empresa no ve
-- ningún anticipo de esta empresa.
set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000102';
select is(
  (select count(*)::integer from public.expense_advances where recipient_id = 'ee000000-0000-0000-0000-000000000102'),
  2, 'Empleado A ve sus propios dos anticipos (CLP cerrado, USD cancelado tras el rechazo)'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'ee000000-0000-0000-0000-000000000105';
select is(
  (select count(*)::integer from public.expense_advances where company_id = 'ee000000-0000-0000-0000-000000000001'),
  0, 'alguien de otra empresa no ve ningún anticipo ajeno'
);
reset role;

select * from finish();
rollback;
