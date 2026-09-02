-- pgTAP GESTORA EX-3: comprobantes privados y aprobación segregada.
create extension if not exists pgtap;

begin;
select plan(34);

select has_table('public', 'expense_receipts', 'existe historial de comprobantes');
select has_column('public', 'expense_reports', 'review_round', 'el informe registra su ronda de revisión');
select has_function('public', 'register_expense_receipt', array['uuid','text','text','text','integer','text'], 'existe registro seguro de comprobante');
select has_function('public', 'decide_expense_report', array['uuid','expense_approval_decision','text'], 'existe flujo cerrado de aprobación');
select ok(not (select public from storage.buckets where id = 'expense-receipts'), 'el bucket de comprobantes es privado');
select is((select file_size_limit from storage.buckets where id = 'expense-receipts'), 10485760::bigint, 'Storage limita cada comprobante a 10 MiB');
select ok(not has_table_privilege('authenticated', 'public.expense_receipts', 'INSERT'), 'metadata solo se registra mediante RPC');
select ok(not has_table_privilege('authenticated', 'public.expense_approval_decisions', 'INSERT'), 'decisiones solo se registran mediante RPC');
select ok(not has_column_privilege('authenticated', 'public.expense_items', 'receipt_status', 'UPDATE'), 'el navegador no puede fingir el estado de un comprobante');
select ok(not has_function_privilege('anon', 'public.decide_expense_report(uuid, public.expense_approval_decision, text)', 'EXECUTE'), 'anon no decide rendiciones');

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

insert into storage.objects (id, bucket_id, name, owner_id, metadata)
values (
  '97000000-0000-0000-0000-000000000501', 'expense-receipts',
  '97000000-0000-0000-0000-000000000001/97000000-0000-0000-0000-000000000102/97000000-0000-0000-0000-000000000301/97000000-0000-0000-0000-000000000401/97000000-0000-0000-0000-000000000501.pdf',
  '97000000-0000-0000-0000-000000000102', '{"mimetype":"application/pdf","size":1234}'::jsonb
);
select lives_ok(
  $$select public.register_expense_receipt(
    '97000000-0000-0000-0000-000000000401',
    '97000000-0000-0000-0000-000000000001/97000000-0000-0000-0000-000000000102/97000000-0000-0000-0000-000000000301/97000000-0000-0000-0000-000000000401/97000000-0000-0000-0000-000000000501.pdf',
    'boleta.pdf', 'application/pdf', 1234,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  )$$,
  'el RPC registra metadata después de existir el objeto privado'
);
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

-- expense_receipts_storage_delete_orphan (hallazgo de la auditoría, P1): NO
-- se puede ejercer con un DELETE real acá -- storage.protect_delete()
-- bloquea CUALQUIER DELETE directo por SQL sobre storage.objects, sin
-- importar RLS ni quién lo intente (verificado empíricamente: hasta el
-- dueño legítimo de un objeto nunca registrado lo recibe). Es a propósito:
-- Supabase exige pasar por la Storage API real para que la baja de
-- metadata y el borrado del archivo en el backend de objetos queden
-- sincronizados. uploadExpenseReceiptAction() ya usa esa API
-- (`supabase.storage.from(...).remove(...)`), nunca SQL directo, así que el
-- borrado real no pasa por este trigger. Lo que sí se puede probar por SQL
-- es que la policy existe y que su condición ("todavía nadie lo registró")
-- es exactamente la correcta.
select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'expense_receipts_storage_delete_orphan' and cmd = 'DELETE'
  ),
  'existe la policy de borrado acotado a comprobantes huérfanos'
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

select * from finish();
rollback;
