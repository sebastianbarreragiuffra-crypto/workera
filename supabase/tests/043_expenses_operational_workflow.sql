-- pgTAP GESTORA EX-2: configuración automática y envío de rendiciones.
create extension if not exists pgtap;

begin;
select plan(36);

-- Desde la etapa F de MFA (docs/MFA_DESIGN.md sección 7), los RPC sensibles
-- llaman a `enforce_mfa_for_privileged()`. Las sesiones de esta prueba ejercen
-- operaciones privilegiadas, así que declaran el nivel que tendría una sesión
-- real después de verificar su segundo factor. No relaja nada: que la guarda
-- distinga aal1 de aal2 se prueba en 049.
set local request.jwt.claim.aal = 'aal2';

select has_table('public', 'expense_report_sequences', 'existe secuencia tenant-aware de folios');
select has_column('public', 'expense_reports', 'reference_number', 'cada rendición tiene folio visible');
select has_function('public', 'submit_expense_report', array['uuid'], 'existe RPC seguro de envío');
select has_function('public', 'expense_dashboard_summary', array['uuid'], 'existe resumen agregado para el dashboard');
select ok(has_function_privilege('authenticated', 'public.submit_expense_report(uuid)', 'EXECUTE'), 'authenticated puede invocar el flujo cerrado');
select ok(not has_function_privilege('anon', 'public.submit_expense_report(uuid)', 'EXECUTE'), 'anon no puede invocar el envío');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('96000000-0000-0000-0000-000000000001', 'Rendiciones Uno', 'Rendiciones Uno SpA', 'rendiciones-uno', true, 'ONBOARDING', false),
  ('96000000-0000-0000-0000-000000000002', 'Rendiciones Dos', 'Rendiciones Dos SpA', 'rendiciones-dos', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('96000000-0000-0000-0000-000000000101', 'Platform EX2', null, true),
  ('96000000-0000-0000-0000-000000000102', 'Rendidor Uno', null, true),
  ('96000000-0000-0000-0000-000000000103', 'Rendidor Dos', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('96000000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('96000000-0000-0000-0000-000000000201', '96000000-0000-0000-0000-000000000102', '96000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('96000000-0000-0000-0000-000000000202', '96000000-0000-0000-0000-000000000103', '96000000-0000-0000-0000-000000000002', 'SUPERVISOR_PRODUCTION', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id and cr.code = 'PRODUCTION_SUPERVISOR'
where cm.id in ('96000000-0000-0000-0000-000000000201', '96000000-0000-0000-0000-000000000202');

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000101';
select lives_ok(
  $$select public.platform_set_company_module_status('96000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$,
  'activar Rendiciones provisiona su configuración en la misma operación'
);
reset role;

select is((select count(*)::integer from public.expense_categories where company_id = '96000000-0000-0000-0000-000000000001'), 5, 'se crean cinco categorías iniciales');
select is((select count(*)::integer from public.expense_policies where company_id = '96000000-0000-0000-0000-000000000001'), 1, 'se crea una política general');
select is((select count(*)::integer from public.expense_categories where company_id = '96000000-0000-0000-0000-000000000002'), 0, 'la configuración no se filtra a otro tenant');

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title) values
  ('96000000-0000-0000-0000-000000000301', '96000000-0000-0000-0000-000000000001', '96000000-0000-0000-0000-000000000102', 'Viaje comercial'),
  ('96000000-0000-0000-0000-000000000302', '96000000-0000-0000-0000-000000000001', '96000000-0000-0000-0000-000000000102', 'Compra menor');

select is((select reference_number from public.expense_reports where id = '96000000-0000-0000-0000-000000000301'), 'RND-2026-000001', 'el primer borrador recibe folio correlativo');
select is((select reference_number from public.expense_reports where id = '96000000-0000-0000-0000-000000000302'), 'RND-2026-000002', 'el segundo borrador recibe el folio siguiente');
select throws_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000301')$$,
  '23514', 'Agrega al menos un gasto con monto mayor a cero antes de enviar.',
  'no se puede enviar una rendición vacía'
);

insert into public.expense_items (
  company_id, report_id, category_id, expense_date, description, net_amount, tax_amount
)
select '96000000-0000-0000-0000-000000000001',
  '96000000-0000-0000-0000-000000000301', ec.id, current_date,
  'Almuerzo con cliente', 15000, 2850
from public.expense_categories ec
where ec.company_id = '96000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';

select lives_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000301')$$,
  'el dueño puede enviar un borrador válido'
);
select ok(
  (select status = 'SUBMITTED' and submitted_at is not null and total_amount = 17850
   from public.expense_reports where id = '96000000-0000-0000-0000-000000000301'),
  'el envío conserva total y registra estado/fecha'
);
select ok(
  (select draft_count = 1 and review_count = 1 and approved_count = 0 and visible_total = 17850
   from public.expense_dashboard_summary('96000000-0000-0000-0000-000000000001')),
  'los KPIs se agregan en base según el alcance autorizado'
);
select throws_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000301')$$,
  '23514', 'Solo se puede enviar una rendición en borrador.',
  'un informe enviado no puede enviarse dos veces'
);
select throws_ok(
  $$update public.expense_reports set status = 'APPROVED' where id = '96000000-0000-0000-0000-000000000301'$$,
  '42501', null, 'el navegador no puede saltarse el flujo cambiando status directamente'
);
reset role;
select is(
  (select count(*)::integer from public.expense_audit_events
   where report_id = '96000000-0000-0000-0000-000000000301'
     and event_type = 'expense_report.status_changed'),
  1, 'el envío deja un evento de auditoría'
);

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000103';
select is((select count(*)::integer from public.expense_reports), 0, 'otro tenant no ve los folios ni informes');
select throws_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000302')$$,
  '42501', 'Rendiciones no está habilitado para esta membresía.',
  'otro tenant no puede enviar un ID conocido'
);
reset role;

set local role anon;
select throws_ok($$select 1 from public.expense_report_sequences$$, '42501', null, 'la tabla interna de secuencias no es pública');
reset role;

select is(
  (select count(*)::integer from public.platform_audit_log
   where company_id = '96000000-0000-0000-0000-000000000001'
     and action = 'company.module.status_changed' and target_id = 'expenses'),
  1, 'la activación sigue auditándose una sola vez'
);
select ok(
  not (select workspace_enabled from public.companies where id = '96000000-0000-0000-0000-000000000001'),
  'el flujo completo no habilita el workspace laboral'
);

-- ---------------------------------------------------------------------------
-- create_expense_report(): idempotencia real ante doble clic o reintento de
-- red (hallazgo de la auditoría, P2) -- nunca se agregó una restricción de
-- "un solo borrador por persona", porque tener varios borradores legítimos
-- a la vez sigue siendo válido; lo único que no debe pasar es duplicar el
-- MISMO intento.
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';

select is(
  (select public.create_expense_report(
    '96000000-0000-0000-0000-000000000001', 'Rendición idempotente', null, 'CLP',
    'aaaaaaaa-0000-0000-0000-000000000001'
  )),
  (select public.create_expense_report(
    '96000000-0000-0000-0000-000000000001', 'Rendición idempotente (reintento)', null, 'CLP',
    'aaaaaaaa-0000-0000-0000-000000000001'
  )),
  'el mismo client_request_id devuelve el mismo borrador en vez de duplicarlo'
);
select is(
  (select count(*)::integer from public.expense_reports
     where company_id = '96000000-0000-0000-0000-000000000001'
       and client_request_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  1,
  'reenviar el mismo client_request_id no crea una segunda fila'
);
select isnt(
  (select public.create_expense_report(
    '96000000-0000-0000-0000-000000000001', 'Otra rendición distinta', null, 'CLP',
    'aaaaaaaa-0000-0000-0000-000000000002'
  )),
  (select id from public.expense_reports where client_request_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'un client_request_id distinto sí crea un borrador nuevo'
);
reset role;

-- withdraw_expense_report() (EX-5): el propio rendidor retira su rendición
-- SUBMITTED sin esperar a que un aprobador la devuelva. El informe 301
-- sigue SUBMITTED desde el bloque de arriba en este mismo archivo.
set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000103';
select throws_ok(
  $$select public.withdraw_expense_report('96000000-0000-0000-0000-000000000301')$$,
  '42501', 'Rendiciones no está habilitado para esta membresía.',
  'otro tenant no puede retirar un ID conocido'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';
select lives_ok(
  $$select public.withdraw_expense_report('96000000-0000-0000-0000-000000000301')$$,
  'el propio rendidor retira su rendición pendiente de revisión'
);
select ok(
  (select status = 'DRAFT' and submitted_at is null and resolved_at is null
     from public.expense_reports where id = '96000000-0000-0000-0000-000000000301'),
  'el retiro deja la rendición en DRAFT lista para corregir'
);
select throws_ok(
  $$select public.withdraw_expense_report('96000000-0000-0000-0000-000000000301')$$,
  '23514', 'Solo se puede retirar una rendición pendiente de revisión.',
  'no se puede retirar algo que ya está en DRAFT'
);
reset role;

-- expense_policies.rules.categoryLimits (EX-5): primer uso real de `rules`
-- -- hasta esta migración era un objeto decorativo (receipt_required_from/
-- duplicate_detection/approval_mode) que ningún código consultaba. Un gasto
-- que supera el límite de su categoría bloquea el ENVÍO, nunca se ajusta el
-- monto en silencio. El informe 301 sigue en DRAFT desde el retiro de
-- arriba, con su único ítem en la categoría OTROS por 17850.
insert into public.company_membership_roles (company_id, membership_id, role_id)
select '96000000-0000-0000-0000-000000000001', '96000000-0000-0000-0000-000000000201', cr.id
from public.company_roles cr
where cr.company_id = '96000000-0000-0000-0000-000000000001' and cr.code = 'HR_ADMIN'
on conflict do nothing;

-- El informe 301 se creó más arriba en este mismo archivo con un INSERT
-- directo (antes de que existiera policy_id como parte del flujo probado
-- acá), así que nunca quedó anclado a una política -- a diferencia de un
-- informe real, que siempre la recibe de create_expense_report() al
-- crearse. Se lo asigna acá explícitamente para simular ese camino real.
update public.expense_reports
set policy_id = (
  select id from public.expense_policies
  where company_id = '96000000-0000-0000-0000-000000000001' and active
)
where id = '96000000-0000-0000-0000-000000000301';

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';

select lives_ok(
  format(
    $$update public.expense_policies set rules = jsonb_build_object('categoryLimits', jsonb_build_object(%L, 10000))
      where company_id = '96000000-0000-0000-0000-000000000001' and active$$,
    (select id::text from public.expense_categories where company_id = '96000000-0000-0000-0000-000000000001' and code = 'OTROS')
  ),
  'expenses.manage puede configurar un límite máximo por categoría'
);
select throws_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000301')$$,
  '23514', 'Un gasto supera el monto máximo permitido para su categoría según la política vigente.',
  'un gasto que supera el límite de su categoría bloquea el envío'
);
select is(
  (select status::text from public.expense_reports where id = '96000000-0000-0000-0000-000000000301'),
  'DRAFT', 'la rendición sigue en DRAFT tras el envío bloqueado por política'
);

update public.expense_policies set rules = '{}'::jsonb
  where company_id = '96000000-0000-0000-0000-000000000001' and active;

select lives_ok(
  $$select public.submit_expense_report('96000000-0000-0000-0000-000000000301')$$,
  'sin límite configurado, el mismo gasto sí puede enviarse'
);
select is(
  (select status::text from public.expense_reports where id = '96000000-0000-0000-0000-000000000301'),
  'SUBMITTED', 'el envío se completa una vez removido el límite'
);
reset role;

select * from finish();
rollback;
