-- pgTAP Fase 2 / bloque 4: vínculo opaco e ingesta WHATSAPP idempotente.
create extension if not exists pgtap;

begin;
set local request.jwt.claim.aal = 'aal2';
select plan(62);

select has_table('public', 'expense_receipt_whatsapp_links', 'existe el vínculo opaco por persona y empresa');
select has_table('public', 'expense_receipt_whatsapp_events', 'existe el ledger durable de mensajes');
select has_table('public', 'expense_receipt_whatsapp_usage_windows', 'existe la cuota horaria del canal');
select has_function('public', 'begin_expense_receipt_whatsapp_pairing', array['uuid','text','timestamptz'], 'existe inicio autenticado de vinculación');
select has_function('public', 'disconnect_expense_receipt_whatsapp', array['uuid'], 'existe desconexión autenticada');
select has_function('public', 'claim_expense_receipt_whatsapp_pairing', array['text','text'], 'existe consumo server-only del código');
select has_function('public', 'resolve_expense_receipt_whatsapp_sender', array['text'], 'existe resolución server-only del remitente');
select has_function('public', 'claim_expense_receipt_whatsapp_event', array['uuid','uuid','text'], 'existe reclamo durable previo a I/O');
select has_function('public', 'reserve_expense_receipt_whatsapp_bytes', array['uuid','uuid','text','uuid','bigint'], 'existe cuota durable previa a descarga');
select has_function('public', 'register_expense_receipt_whatsapp_capture', array['uuid','uuid','text','text','text','integer','text','text','uuid'], 'existe registro WHATSAPP idempotente');
select has_function('public', 'complete_expense_receipt_whatsapp_event', array['uuid','uuid','text','uuid'], 'existe cierre durable del mensaje');
select has_function('public', 'release_expense_receipt_whatsapp_event', array['uuid','uuid','text','uuid'], 'existe liberación recuperable del mensaje');

select ok(has_table_privilege('authenticated', 'public.expense_receipt_whatsapp_links', 'SELECT'), 'el usuario puede consultar su vínculo');
select ok(not has_table_privilege('authenticated', 'public.expense_receipt_whatsapp_links', 'INSERT'), 'el navegador no inventa vínculos');
select ok(not has_table_privilege('authenticated', 'public.expense_receipt_whatsapp_events', 'SELECT'), 'el navegador no lee el ledger técnico');
select ok(not has_table_privilege('authenticated', 'public.expense_receipt_whatsapp_usage_windows', 'SELECT'), 'el navegador no lee contadores de abuso');
select ok(has_function_privilege('authenticated', 'public.begin_expense_receipt_whatsapp_pairing(uuid, text, timestamptz)', 'EXECUTE'), 'un usuario autorizado puede iniciar la vinculación');
select ok(has_function_privilege('authenticated', 'public.disconnect_expense_receipt_whatsapp(uuid)', 'EXECUTE'), 'un usuario puede revocar su propio vínculo');
select ok(not has_function_privilege('authenticated', 'public.claim_expense_receipt_whatsapp_pairing(text, text)', 'EXECUTE'), 'el navegador no consume códigos');
select ok(not has_function_privilege('authenticated', 'public.resolve_expense_receipt_whatsapp_sender(text)', 'EXECUTE'), 'el navegador no resuelve remitentes');
select ok(not has_function_privilege('authenticated', 'public.claim_expense_receipt_whatsapp_event(uuid, uuid, text)', 'EXECUTE'), 'el navegador no reclama mensajes');
select ok(not has_function_privilege('authenticated', 'public.reserve_expense_receipt_whatsapp_bytes(uuid, uuid, text, uuid, bigint)', 'EXECUTE'), 'el navegador no reserva tráfico');
select ok(not has_function_privilege('authenticated', 'public.register_expense_receipt_whatsapp_capture(uuid, uuid, text, text, text, integer, text, text, uuid)', 'EXECUTE'), 'el navegador no registra capturas del proveedor');
select ok(not has_function_privilege('authenticated', 'public.complete_expense_receipt_whatsapp_event(uuid, uuid, text, uuid)', 'EXECUTE'), 'el navegador no completa mensajes');
select ok(not has_function_privilege('authenticated', 'public.release_expense_receipt_whatsapp_event(uuid, uuid, text, uuid)', 'EXECUTE'), 'el navegador no libera mensajes');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('99100000-0000-0000-0000-000000000001', 'WhatsApp Uno', 'WhatsApp Uno SpA', 'whatsapp-uno', true, 'ONBOARDING', false),
  ('99100000-0000-0000-0000-000000000002', 'WhatsApp Dos', 'WhatsApp Dos SpA', 'whatsapp-dos', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('99100000-0000-0000-0000-000000000101', 'Platform WhatsApp', null, true),
  ('99100000-0000-0000-0000-000000000102', 'Rendidor WhatsApp', null, true),
  ('99100000-0000-0000-0000-000000000103', 'Compañero WhatsApp', null, true),
  ('99100000-0000-0000-0000-000000000104', 'Rendidor Ajeno WhatsApp', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('99100000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('99100000-0000-0000-0000-000000000201', '99100000-0000-0000-0000-000000000102', '99100000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('99100000-0000-0000-0000-000000000202', '99100000-0000-0000-0000-000000000103', '99100000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('99100000-0000-0000-0000-000000000203', '99100000-0000-0000-0000-000000000104', '99100000-0000-0000-0000-000000000002', 'SUPERVISOR_PRODUCTION', true);

set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000101';
select lives_ok($$select public.platform_set_company_module_status('99100000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$, 'se activa Rendiciones en empresa uno');
select lives_ok($$select public.platform_set_company_module_status('99100000-0000-0000-0000-000000000002', 'expenses', 'PILOT')$$, 'se activa Rendiciones en empresa dos');
reset role;

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id and cr.code = 'PRODUCTION_SUPERVISOR'
where cm.id in (
  '99100000-0000-0000-0000-000000000201',
  '99100000-0000-0000-0000-000000000202',
  '99100000-0000-0000-0000-000000000203'
);

set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000102';
select lives_ok(
  $$select public.begin_expense_receipt_whatsapp_pairing(
    '99100000-0000-0000-0000-000000000001', repeat('a', 64), now() + interval '10 minutes'
  )$$,
  'el rendidor genera un código de un solo uso'
);
select is((select count(*)::integer from public.expense_receipt_whatsapp_links), 1, 'RLS muestra únicamente su vínculo');
select throws_ok(
  $$select public.begin_expense_receipt_whatsapp_pairing(
    '99100000-0000-0000-0000-000000000002', repeat('b', 64), now() + interval '10 minutes'
  )$$,
  '42501', 'No puedes vincular WhatsApp en esta empresa.', 'no se vincula en otra empresa'
);
select throws_ok(
  $$select public.begin_expense_receipt_whatsapp_pairing(
    '99100000-0000-0000-0000-000000000001', repeat('b', 64), now() + interval '30 minutes'
  )$$,
  '23514', 'La vinculación debe vencer entre 1 y 15 minutos.', 'un código no puede quedar vigente indefinidamente'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000103';
select is((select count(*)::integer from public.expense_receipt_whatsapp_links), 0, 'otro miembro no ve el vínculo');
reset role;

set local role service_role;
select is(
  (select count(*)::integer from public.claim_expense_receipt_whatsapp_pairing(repeat('a', 64), repeat('1', 64))),
  1,
  'el código vigente vincula exactamente un remitente'
);
select ok(
  (select active and pairing_token_hash is null and pairing_expires_at is null
   from public.expense_receipt_whatsapp_links
   where company_id = '99100000-0000-0000-0000-000000000001'
     and user_id = '99100000-0000-0000-0000-000000000102'),
  'el código se consume y no queda reutilizable'
);
select is(
  (select count(*)::integer from public.claim_expense_receipt_whatsapp_pairing(repeat('a', 64), repeat('1', 64))),
  0,
  'el mismo código no puede vincularse dos veces'
);
select is((select count(*)::integer from public.resolve_expense_receipt_whatsapp_sender(repeat('1', 64))), 1, 'el remitente vinculado resuelve una identidad');
reset role;

update public.company_memberships set active = false
where company_id = '99100000-0000-0000-0000-000000000001'
  and user_id = '99100000-0000-0000-0000-000000000102';
set local role service_role;
select is((select count(*)::integer from public.resolve_expense_receipt_whatsapp_sender(repeat('1', 64))), 0, 'la membresía inactiva revoca el canal inmediatamente');
reset role;
update public.company_memberships set active = true
where company_id = '99100000-0000-0000-0000-000000000001'
  and user_id = '99100000-0000-0000-0000-000000000102';

set local role service_role;
select is((select count(*)::integer from public.resolve_expense_receipt_whatsapp_sender(repeat('1', 64))), 1, 'al reactivar la membresía vuelve a resolver el vínculo');

create temporary table whatsapp_claim as
select * from public.claim_expense_receipt_whatsapp_event(
  '99100000-0000-0000-0000-000000000102',
  '99100000-0000-0000-0000-000000000001', repeat('2', 64)
);
select is((select result from whatsapp_claim), 'CLAIMED', 'el mensaje se reclama antes de consultar el archivo');
select ok((select claim_token is not null from whatsapp_claim), 'el reclamo entrega un token de fencing');
select is(
  (select result from public.claim_expense_receipt_whatsapp_event(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001', repeat('2', 64)
  )),
  'IN_PROGRESS', 'un replay concurrente no vuelve a procesar el archivo'
);
select is(
  public.reserve_expense_receipt_whatsapp_bytes(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001', repeat('2', 64),
    (select claim_token from whatsapp_claim), 1000
  ),
  true, 'los bytes se reservan antes de descargar el archivo'
);
select is(
  public.reserve_expense_receipt_whatsapp_bytes(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001', repeat('2', 64),
    '99100000-0000-0000-0000-000000000999', 1000
  ),
  false, 'un worker sin la lease no puede consumir la reserva'
);
select throws_ok(
  $$select public.register_expense_receipt_whatsapp_capture(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001',
    '99100000-0000-0000-0000-000000000001/99100000-0000-0000-0000-000000000102/inbox/99100000-0000-0000-0000-000000000501.pdf',
    'boleta.pdf', 'application/pdf', 1000, repeat('c', 64), repeat('2', 64),
    (select claim_token from whatsapp_claim)
  )$$,
  '23503', 'El archivo no existe en el almacenamiento privado.', 'no se registra metadata sin objeto privado'
);

insert into storage.objects (id, bucket_id, name, owner_id, metadata)
values (
  '99100000-0000-0000-0000-000000000501', 'expense-receipts',
  '99100000-0000-0000-0000-000000000001/99100000-0000-0000-0000-000000000102/inbox/99100000-0000-0000-0000-000000000501.pdf',
  '99100000-0000-0000-0000-000000000102', '{"mimetype":"application/pdf","size":1000}'::jsonb
);
create temporary table whatsapp_capture as
select public.register_expense_receipt_whatsapp_capture(
  '99100000-0000-0000-0000-000000000102',
  '99100000-0000-0000-0000-000000000001',
  '99100000-0000-0000-0000-000000000001/99100000-0000-0000-0000-000000000102/inbox/99100000-0000-0000-0000-000000000501.pdf',
  'boleta.pdf', 'application/pdf', 1000, repeat('c', 64), repeat('2', 64),
  (select claim_token from whatsapp_claim)
) as id;
select is((select count(*)::integer from public.expense_receipt_captures where source = 'WHATSAPP'), 1, 'el webhook registra una sola captura');
select is((select source from public.expense_receipt_captures where id = (select id from whatsapp_capture)), 'WHATSAPP', 'la captura conserva su canal de origen');
select is(
  public.register_expense_receipt_whatsapp_capture(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001',
    '99100000-0000-0000-0000-000000000001/99100000-0000-0000-0000-000000000102/inbox/99100000-0000-0000-0000-000000000599.pdf',
    'reintento.pdf', 'application/pdf', 1000, repeat('d', 64), repeat('2', 64),
    (select claim_token from whatsapp_claim)
  ),
  (select id from whatsapp_capture), 'un reintento idempotente devuelve la captura existente'
);
select is(
  public.complete_expense_receipt_whatsapp_event(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001', repeat('2', 64),
    (select claim_token from whatsapp_claim)
  ),
  true, 'el mensaje se completa con la lease vigente'
);
select is(
  (select result from public.claim_expense_receipt_whatsapp_event(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001', repeat('2', 64)
  )),
  'COMPLETED', 'un replay completado no vuelve a descargar'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000102';
select is((select count(*)::integer from public.expense_receipt_captures where source = 'WHATSAPP'), 1, 'el dueño ve su captura de WhatsApp');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000103';
select is((select count(*)::integer from public.expense_receipt_captures where source = 'WHATSAPP'), 0, 'otro miembro no ve la captura');
reset role;

set local role service_role;
select throws_ok(
  $$select public.register_expense_receipt_whatsapp_capture(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001',
    '99100000-0000-0000-0000-000000000002/99100000-0000-0000-0000-000000000102/inbox/99100000-0000-0000-0000-000000000502.png',
    'ajena.png', 'image/png', 1000, repeat('e', 64), repeat('3', 64),
    '99100000-0000-0000-0000-000000000999'
  )$$,
  '23514', 'Captura de WhatsApp inválida.', 'la ruta no puede cambiar de tenant'
);

create temporary table retry_claim_one as
select * from public.claim_expense_receipt_whatsapp_event(
  '99100000-0000-0000-0000-000000000102',
  '99100000-0000-0000-0000-000000000001', repeat('3', 64)
);
select is((select result from retry_claim_one), 'CLAIMED', 'un mensaje nuevo obtiene una lease');
select is(
  public.release_expense_receipt_whatsapp_event(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001', repeat('3', 64),
    (select claim_token from retry_claim_one)
  ),
  true, 'un fallo transitorio libera la lease'
);
select is(
  public.complete_expense_receipt_whatsapp_event(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001', repeat('3', 64),
    (select claim_token from retry_claim_one)
  ),
  false, 'un worker antiguo no puede cerrar el reintento'
);
create temporary table retry_claim_two as
select * from public.claim_expense_receipt_whatsapp_event(
  '99100000-0000-0000-0000-000000000102',
  '99100000-0000-0000-0000-000000000001', repeat('3', 64)
);
select is((select result from retry_claim_two), 'CLAIMED', 'el reintento obtiene una lease nueva');
select isnt((select claim_token from retry_claim_two), (select claim_token from retry_claim_one), 'cada intento usa un token de fencing distinto');
select is(
  public.reserve_expense_receipt_whatsapp_bytes(
    '99100000-0000-0000-0000-000000000102',
    '99100000-0000-0000-0000-000000000001', repeat('3', 64),
    (select claim_token from retry_claim_two), 10485761
  ),
  false, 'un archivo mayor a 10 MiB se rechaza antes de descargar'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000104';
select is(public.disconnect_expense_receipt_whatsapp('99100000-0000-0000-0000-000000000001'), false, 'otro tenant no puede desconectar el vínculo');
reset role;
set local role service_role;
select is((select count(*)::integer from public.resolve_expense_receipt_whatsapp_sender(repeat('1', 64))), 1, 'el intento IDOR no cambia el vínculo');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '99100000-0000-0000-0000-000000000102';
select is(public.disconnect_expense_receipt_whatsapp('99100000-0000-0000-0000-000000000001'), true, 'el dueño revoca su vínculo');
reset role;
set local role service_role;
select is((select count(*)::integer from public.resolve_expense_receipt_whatsapp_sender(repeat('1', 64))), 0, 'la desconexión invalida el remitente');
reset role;

select * from finish();
rollback;
