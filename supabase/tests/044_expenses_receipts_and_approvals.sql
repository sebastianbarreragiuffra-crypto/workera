-- pgTAP GESTORA EX-3: comprobantes privados y aprobación segregada.
create extension if not exists pgtap;

begin;
select plan(47);

-- Desde la etapa F de MFA (docs/MFA_DESIGN.md sección 7), los RPC sensibles
-- llaman a `enforce_mfa_for_privileged()`. Las sesiones de esta prueba ejercen
-- operaciones privilegiadas, así que declaran el nivel que tendría una sesión
-- real después de verificar su segundo factor. No relaja nada: que la guarda
-- distinga aal1 de aal2 se prueba en 049.
set local request.jwt.claim.aal = 'aal2';

select has_table('public', 'expense_receipts', 'existe historial de comprobantes');
select has_column('public', 'expense_reports', 'review_round', 'el informe registra su ronda de revisión');
select has_function('public', 'register_expense_receipt_trusted', array['uuid','uuid','uuid','text','text','text','integer','text'], 'existe registro seguro server-only de comprobante');
select has_function('public', 'decide_expense_report', array['uuid','expense_approval_decision','text'], 'existe flujo cerrado de aprobación');
select ok(not (select public from storage.buckets where id = 'expense-receipts'), 'el bucket de comprobantes es privado');
select is((select file_size_limit from storage.buckets where id = 'expense-receipts'), 10485760::bigint, 'Storage limita cada comprobante a 10 MiB');
select ok(not has_table_privilege('authenticated', 'public.expense_receipts', 'INSERT'), 'metadata solo se registra mediante RPC');
select ok(not has_table_privilege('authenticated', 'public.expense_approval_decisions', 'INSERT'), 'decisiones solo se registran mediante RPC');
select ok(not has_column_privilege('authenticated', 'public.expense_items', 'receipt_status', 'UPDATE'), 'el navegador no puede fingir el estado de un comprobante');
select ok(not has_function_privilege('anon', 'public.decide_expense_report(uuid, public.expense_approval_decision, text)', 'EXECUTE'), 'anon no decide rendiciones');
select ok(not has_function_privilege('authenticated', 'public.register_expense_receipt(uuid, text, text, text, integer, text)', 'EXECUTE'), 'el navegador no registra hashes de comprobantes directamente');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('97000000-0000-0000-0000-000000000001', 'Gastos Seguro', 'Gastos Seguro SpA', 'gastos-seguro', true, 'ONBOARDING', false),
  ('97000000-0000-0000-0000-000000000002', 'Gastos Ajeno', 'Gastos Ajeno SpA', 'gastos-ajeno', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('97000000-0000-0000-0000-000000000101', 'Platform EX3', null, true),
  ('97000000-0000-0000-0000-000000000102', 'Rendidor EX3', null, true),
  ('97000000-0000-0000-0000-000000000103', 'Aprobador EX3', null, true),
  ('97000000-0000-0000-0000-000000000104', 'Ajeno EX3', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('97000000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('97000000-0000-0000-0000-000000000201', '97000000-0000-0000-0000-000000000102', '97000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('97000000-0000-0000-0000-000000000202', '97000000-0000-0000-0000-000000000103', '97000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('97000000-0000-0000-0000-000000000203', '97000000-0000-0000-0000-000000000104', '97000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id = '97000000-0000-0000-0000-000000000201' and cr.code = 'PRODUCTION_SUPERVISOR')
   or (cm.id in ('97000000-0000-0000-0000-000000000202','97000000-0000-0000-0000-000000000203') and cr.code = 'HR_ADMIN');

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000101';
select lives_ok($$select public.platform_set_company_module_status('97000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$, 'se activa Rendiciones');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title)
values ('97000000-0000-0000-0000-000000000301', '97000000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-000000000102', 'Viaje con boleta');
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select '97000000-0000-0000-0000-000000000401', '97000000-0000-0000-0000-000000000001',
  '97000000-0000-0000-0000-000000000301', ec.id, current_date, 'Hotel', 50000
from public.expense_categories ec
where ec.company_id = '97000000-0000-0000-0000-000000000001' and ec.code = 'ALOJAMIENTO';

select throws_ok(
  $$select public.submit_expense_report('97000000-0000-0000-0000-000000000301')$$,
  '23514', 'Adjunta los comprobantes obligatorios antes de enviar.',
  'no se envía una categoría obligatoria sin comprobante'
);
select ok(public.can_upload_expense_receipt_path(
  '97000000-0000-0000-0000-000000000001/97000000-0000-0000-0000-000000000102/97000000-0000-0000-0000-000000000301/97000000-0000-0000-0000-000000000401/97000000-0000-0000-0000-000000000501.pdf'
), 'la ruta propia y vinculada al borrador es válida');
select ok(not public.can_upload_expense_receipt_path(
  '97000000-0000-0000-0000-000000000002/97000000-0000-0000-0000-000000000102/97000000-0000-0000-0000-000000000301/97000000-0000-0000-0000-000000000401/97000000-0000-0000-0000-000000000501.pdf'
), 'la ruta no puede cambiar de tenant');

reset role;

insert into storage.objects (id, bucket_id, name, owner_id, metadata)
values (
  '97000000-0000-0000-0000-000000000501', 'expense-receipts',
  '97000000-0000-0000-0000-000000000001/97000000-0000-0000-0000-000000000102/97000000-0000-0000-0000-000000000301/97000000-0000-0000-0000-000000000401/97000000-0000-0000-0000-000000000501.pdf',
  '97000000-0000-0000-0000-000000000102', '{"mimetype":"application/pdf","size":1234}'::jsonb
);
set local role service_role;
select lives_ok(
  $$select public.register_expense_receipt_trusted(
    '97000000-0000-0000-0000-000000000102',
    '97000000-0000-0000-0000-000000000001',
    '97000000-0000-0000-0000-000000000401',
    '97000000-0000-0000-0000-000000000001/97000000-0000-0000-0000-000000000102/97000000-0000-0000-0000-000000000301/97000000-0000-0000-0000-000000000401/97000000-0000-0000-0000-000000000501.pdf',
    'boleta.pdf', 'application/pdf', 1234,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )$$,
  'el RPC registra metadata después de existir el objeto privado'
);
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000102';
select ok((select receipt_status = 'UPLOADED' and receipt_storage_path is not null from public.expense_items where id = '97000000-0000-0000-0000-000000000401'), 'el ítem refleja su comprobante vigente');
select lives_ok($$select public.submit_expense_report('97000000-0000-0000-0000-000000000301')$$, 'con comprobante puede enviarse');
select is((select review_round from public.expense_reports where id = '97000000-0000-0000-0000-000000000301'), 1, 'el envío abre la primera ronda');
select throws_ok(
  $$select public.decide_expense_report('97000000-0000-0000-0000-000000000301', 'APPROVED', null)$$,
  '42501', 'Tu rol no permite decidir esta rendición.',
  'un rendidor sin permiso no decide'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000103';
select throws_ok(
  $$insert into public.expense_approval_decisions (company_id, report_id, step_number, decided_by, decision)
    values ('97000000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-000000000301', 1, '97000000-0000-0000-0000-000000000103', 'APPROVED')$$,
  '42501', null, 'ni un aprobador inserta decisiones saltándose el RPC'
);
select lives_ok(
  $$select public.decide_expense_report('97000000-0000-0000-0000-000000000301', 'RETURNED', 'Corrige el centro de costo')$$,
  'un aprobador distinto puede devolver el informe'
);
select ok((select status = 'DRAFT' and submitted_at is null and resolved_at is null from public.expense_reports where id = '97000000-0000-0000-0000-000000000301'), 'la devolución reabre el borrador sin borrar historial');
reset role;

-- Desde Fase 2 toda escritura y limpieza usa el servicio server-only. El
-- navegador autenticado conserva solo SELECT y no puede crear ni borrar
-- objetos, ni siquiera huérfanos.
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'expense_receipts_storage_delete_orphan' and cmd = 'DELETE'
  ),
  'el navegador no puede borrar objetos del bucket de comprobantes'
);
select ok(
  not exists (
    select 1 from public.expense_receipts
    where storage_path = '97000000-0000-0000-0000-000000000001/97000000-0000-0000-0000-000000000102/97000000-0000-0000-0000-000000000301/97000000-0000-0000-0000-000000000401/97000000-0000-0000-0000-000000000502.pdf'
  ),
  'una ruta nunca registrada calificaría como huérfana para la policy'
);
select ok(
  exists (
    select 1 from public.expense_receipts
    where storage_path = '97000000-0000-0000-0000-000000000001/97000000-0000-0000-0000-000000000102/97000000-0000-0000-0000-000000000301/97000000-0000-0000-0000-000000000401/97000000-0000-0000-0000-000000000501.pdf'
  ),
  'un comprobante ya registrado nunca calificaría como huérfano para la policy'
);

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000102';
select lives_ok($$select public.submit_expense_report('97000000-0000-0000-0000-000000000301')$$, 'el dueño reenvía el borrador corregido');
select is((select review_round from public.expense_reports where id = '97000000-0000-0000-0000-000000000301'), 2, 'el reenvío abre una ronda nueva');
select throws_ok(
  $$select public.decide_expense_report('97000000-0000-0000-0000-000000000301', 'APPROVED', null)$$,
  '42501', 'Tu rol no permite decidir esta rendición.', 'el rendidor sigue sin permiso de aprobación'
);
reset role;

-- Otorga aprobación al mismo rendidor para demostrar que la segregación se
-- aplica incluso cuando el rol tiene permiso formal.
insert into public.company_membership_roles (company_id, membership_id, role_id)
select '97000000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-000000000201', cr.id
from public.company_roles cr
where cr.company_id = '97000000-0000-0000-0000-000000000001' and cr.code = 'HR_ADMIN'
on conflict do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.decide_expense_report('97000000-0000-0000-0000-000000000301', 'APPROVED', null)$$,
  '42501', 'No puedes aprobar ni rechazar tu propia rendición.', 'el permiso jamás habilita autoaprobación'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000103';
select lives_ok($$select public.decide_expense_report('97000000-0000-0000-0000-000000000301', 'APPROVED', null)$$, 'otro aprobador cierra la segunda ronda');
select ok((select status = 'APPROVED' and resolved_at is not null from public.expense_reports where id = '97000000-0000-0000-0000-000000000301'), 'la aprobación resuelve el informe');
select is((select count(*)::integer from public.expense_approval_decisions where report_id = '97000000-0000-0000-0000-000000000301'), 2, 'se conserva una decisión por ronda');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000104';
select is((select count(*)::integer from public.expense_receipts), 0, 'otro tenant no ve metadata de comprobantes');
select ok(not public.can_read_expense_receipt_path(
  '97000000-0000-0000-0000-000000000001/97000000-0000-0000-0000-000000000102/97000000-0000-0000-0000-000000000301/97000000-0000-0000-0000-000000000401/97000000-0000-0000-0000-000000000501.pdf'
), 'otro tenant tampoco obtiene acceso al archivo');
reset role;

-- ---------------------------------------------------------------------------
-- Cadenas de aprobación multi-paso (EX-5): el disparador es el MONTO TOTAL
-- de la rendición contra expense_policies.rules.secondApproverThreshold.
-- submit_expense_report() congela el resultado en required_approval_steps
-- -- decide_expense_report() nunca vuelve a leer la política en vivo, y
-- exige un aprobador DISTINTO por cada paso de la misma ronda.
select is(
  (select required_approval_steps from public.expense_reports where id = '97000000-0000-0000-0000-000000000301'),
  1, 'un informe enviado sin umbral configurado quedó con un solo paso requerido'
);

insert into public.profiles (id, display_name, role, active) values
  ('97000000-0000-0000-0000-000000000105', 'Aprobador EX3 Dos', null, true);
insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('97000000-0000-0000-0000-000000000204', '97000000-0000-0000-0000-000000000105', '97000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select '97000000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-000000000204', cr.id
from public.company_roles cr
where cr.company_id = '97000000-0000-0000-0000-000000000001' and cr.code = 'HR_ADMIN';

update public.expense_policies
set rules = jsonb_set(coalesce(rules, '{}'::jsonb), '{secondApproverThreshold}', to_jsonb(100000))
where company_id = '97000000-0000-0000-0000-000000000001' and active;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title, policy_id)
select '97000000-0000-0000-0000-000000000302', '97000000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-000000000102', 'Compra grande',
  (select id from public.expense_policies where company_id = '97000000-0000-0000-0000-000000000001' and active);
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select '97000000-0000-0000-0000-000000000402', '97000000-0000-0000-0000-000000000001',
  '97000000-0000-0000-0000-000000000302', ec.id, current_date, 'Equipamiento', 150000
from public.expense_categories ec
where ec.company_id = '97000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';

select lives_ok(
  $$select public.submit_expense_report('97000000-0000-0000-0000-000000000302')$$,
  'se envía una rendición cuyo total supera el umbral de segundo aprobador'
);
select is(
  (select required_approval_steps from public.expense_reports where id = '97000000-0000-0000-0000-000000000302'),
  2, 'el envío congela dos pasos requeridos según el umbral vigente'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000103';
select lives_ok(
  $$select public.decide_expense_report('97000000-0000-0000-0000-000000000302', 'APPROVED', null)$$,
  'el primer aprobador resuelve el primer paso'
);
select is(
  (select status::text from public.expense_reports where id = '97000000-0000-0000-0000-000000000302'),
  'IN_REVIEW', 'con dos pasos requeridos, el primero deja la rendición IN_REVIEW en vez de aprobarla'
);
select throws_ok(
  $$select public.decide_expense_report('97000000-0000-0000-0000-000000000302', 'APPROVED', null)$$,
  '42501', 'Ya registraste una decisión para esta rendición en esta ronda; otra persona debe resolver el siguiente paso.',
  'la misma persona no puede resolver dos pasos de la misma ronda'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000105';
select lives_ok(
  $$select public.decide_expense_report('97000000-0000-0000-0000-000000000302', 'APPROVED', null)$$,
  'una segunda persona distinta resuelve el paso final'
);
select ok(
  (select status = 'APPROVED' and resolved_at is not null from public.expense_reports where id = '97000000-0000-0000-0000-000000000302'),
  'al completar los dos pasos requeridos, recién ahí queda aprobada'
);
select is(
  (select count(*)::integer from public.expense_approval_decisions where report_id = '97000000-0000-0000-0000-000000000302'),
  2, 'quedan registradas las dos decisiones de la misma ronda'
);
reset role;

-- Un rechazo en cualquier paso es terminal de inmediato, sin esperar el
-- segundo paso aunque el snapshot exija dos.
set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title, policy_id)
select '97000000-0000-0000-0000-000000000303', '97000000-0000-0000-0000-000000000001', '97000000-0000-0000-0000-000000000102', 'Compra grande rechazada',
  (select id from public.expense_policies where company_id = '97000000-0000-0000-0000-000000000001' and active);
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select '97000000-0000-0000-0000-000000000403', '97000000-0000-0000-0000-000000000001',
  '97000000-0000-0000-0000-000000000303', ec.id, current_date, 'Otro equipo', 150000
from public.expense_categories ec
where ec.company_id = '97000000-0000-0000-0000-000000000001' and ec.code = 'OTROS';
select lives_ok(
  $$select public.submit_expense_report('97000000-0000-0000-0000-000000000303')$$,
  'se envía una segunda rendición sobre el umbral'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '97000000-0000-0000-0000-000000000103';
select lives_ok(
  $$select public.decide_expense_report('97000000-0000-0000-0000-000000000303', 'REJECTED', 'No corresponde a la política de compras')$$,
  'el primer aprobador puede rechazar de inmediato'
);
select ok(
  (select status = 'REJECTED' and resolved_at is not null from public.expense_reports where id = '97000000-0000-0000-0000-000000000303'),
  'un rechazo es terminal sin esperar el segundo paso, aunque el snapshot exigiera dos'
);
reset role;

select * from finish();
rollback;
