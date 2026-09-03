-- pgTAP Fase 2 / bloque 3: alias opaco e ingesta EMAIL idempotente.
create extension if not exists pgtap;

begin;
select plan(77);

select has_table('public', 'expense_receipt_email_aliases', 'existe el alias de correo por persona y empresa');
select has_table('public', 'expense_receipt_email_events', 'existe el ledger durable de eventos de correo');
select has_table('public', 'expense_receipt_email_usage_windows', 'existe la cuota horaria agregada del canal');
select has_column('public', 'expense_receipt_email_aliases', 'alias_token', 'el alias usa un token opaco');
select has_function('public', 'ensure_expense_receipt_email_alias', array['uuid'], 'existe activación autenticada del alias');
select has_function('public', 'rotate_expense_receipt_email_alias', array['uuid'], 'existe rotación autenticada del alias');
select has_function('public', 'resolve_expense_receipt_email_alias', array['uuid'], 'existe resolución server-only');
select has_function('public', 'claim_expense_receipt_email_event', array['uuid','uuid','text','text','integer'], 'existe reclamo durable previo a I/O');
select has_function('public', 'reserve_expense_receipt_email_bytes', array['uuid','uuid','text','uuid','bigint'], 'existe cuota durable de bytes previa a descarga');
select has_function('public', 'complete_expense_receipt_email_event', array['uuid','uuid','text','uuid'], 'existe cierre durable del evento');
select has_function('public', 'release_expense_receipt_email_event', array['uuid','uuid','text','uuid'], 'existe liberación recuperable del evento');
select has_function('public', 'register_inbound_expense_receipt_capture', array['uuid','uuid','text','text','text','integer','text','text','text','uuid'], 'existe registro EMAIL idempotente');
select ok(not has_table_privilege('authenticated', 'public.expense_receipt_email_aliases', 'INSERT'), 'el navegador no inventa alias');
select ok(not has_table_privilege('authenticated', 'public.expense_receipt_email_aliases', 'UPDATE'), 'el navegador no rota alias directo');
select ok(not has_table_privilege('authenticated', 'public.expense_receipt_email_events', 'SELECT'), 'el navegador no lee el ledger técnico');
select ok(not has_table_privilege('authenticated', 'public.expense_receipt_email_usage_windows', 'SELECT'), 'el navegador no lee contadores de abuso');
select ok(has_function_privilege('authenticated', 'public.ensure_expense_receipt_email_alias(uuid)', 'EXECUTE'), 'un usuario autorizado puede activar su alias');
select ok(has_function_privilege('authenticated', 'public.rotate_expense_receipt_email_alias(uuid)', 'EXECUTE'), 'un usuario autorizado puede rotar su alias');
select ok(not has_function_privilege('authenticated', 'public.resolve_expense_receipt_email_alias(uuid)', 'EXECUTE'), 'el navegador no resuelve capacidades secretas');
select ok(not has_function_privilege('authenticated', 'public.claim_expense_receipt_email_event(uuid, uuid, text, text, integer)', 'EXECUTE'), 'el navegador no reclama eventos del proveedor');
select ok(not has_function_privilege('authenticated', 'public.reserve_expense_receipt_email_bytes(uuid, uuid, text, uuid, bigint)', 'EXECUTE'), 'el navegador no reserva tráfico del proveedor');
select ok(not has_function_privilege('authenticated', 'public.complete_expense_receipt_email_event(uuid, uuid, text, uuid)', 'EXECUTE'), 'el navegador no completa eventos del proveedor');
select ok(not has_function_privilege('authenticated', 'public.release_expense_receipt_email_event(uuid, uuid, text, uuid)', 'EXECUTE'), 'el navegador no libera eventos del proveedor');
select ok(not has_function_privilege('authenticated', 'public.register_inbound_expense_receipt_capture(uuid, uuid, text, text, text, integer, text, text, text, uuid)', 'EXECUTE'), 'el navegador no registra correo como proveedor');

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('99000000-0000-0000-0000-000000000001', 'Correo Uno', 'Correo Uno SpA', 'correo-uno', true, 'ONBOARDING', false),
  ('99000000-0000-0000-0000-000000000002', 'Correo Dos', 'Correo Dos SpA', 'correo-dos', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('99000000-0000-0000-0000-000000000101', 'Platform Correo', null, true),
  ('99000000-0000-0000-0000-000000000102', 'Rendidor Correo', null, true),
  ('99000000-0000-0000-0000-000000000103', 'Compañero Correo', null, true),
  ('99000000-0000-0000-0000-000000000104', 'Rendidor Ajeno', null, true),
  ('99000000-0000-0000-0000-000000000105', 'Rendidor Sin Adjunto', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('99000000-0000-0000-0000-000000000101', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('99000000-0000-0000-0000-000000000201', '99000000-0000-0000-0000-000000000102', '99000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('99000000-0000-0000-0000-000000000202', '99000000-0000-0000-0000-000000000103', '99000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('99000000-0000-0000-0000-000000000203', '99000000-0000-0000-0000-000000000104', '99000000-0000-0000-0000-000000000002', 'SUPERVISOR_PRODUCTION', true),
  ('99000000-0000-0000-0000-000000000204', '99000000-0000-0000-0000-000000000105', '99000000-0000-0000-0000-000000000002', 'SUPERVISOR_PRODUCTION', true);

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000101';
select lives_ok($$select public.platform_set_company_module_status('99000000-0000-0000-0000-000000000001', 'expenses', 'PILOT')$$, 'se activa Rendiciones en empresa uno');
select lives_ok($$select public.platform_set_company_module_status('99000000-0000-0000-0000-000000000002', 'expenses', 'PILOT')$$, 'se activa Rendiciones en empresa dos');
reset role;

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id and cr.code = 'PRODUCTION_SUPERVISOR'
where cm.id in (
  '99000000-0000-0000-0000-000000000201',
  '99000000-0000-0000-0000-000000000202',
  '99000000-0000-0000-0000-000000000203',
  '99000000-0000-0000-0000-000000000204'
);

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000102';
select lives_ok($$select public.ensure_expense_receipt_email_alias('99000000-0000-0000-0000-000000000001')$$, 'el rendidor activa su dirección');
select is((select count(*)::integer from public.expense_receipt_email_aliases), 1, 'RLS muestra únicamente su alias');
create temporary table email_alias_before as
select alias_token from public.expense_receipt_email_aliases;
grant select on email_alias_before to authenticated, service_role;
select is(
  public.ensure_expense_receipt_email_alias('99000000-0000-0000-0000-000000000001'),
  (select alias_token from email_alias_before),
  'activar nuevamente conserva la dirección'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000103';
select is((select count(*)::integer from public.expense_receipt_email_aliases), 0, 'un compañero no ve el alias secreto');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000102';
select lives_ok($$select public.rotate_expense_receipt_email_alias('99000000-0000-0000-0000-000000000001')$$, 'el dueño rota la dirección');
select isnt(
  (select alias_token from public.expense_receipt_email_aliases),
  (select alias_token from email_alias_before),
  'la rotación invalida el token anterior'
);
create temporary table email_alias_after as
select alias_token from public.expense_receipt_email_aliases;
grant select on email_alias_after to authenticated, service_role;
reset role;

set local role service_role;
select is((select count(*)::integer from public.resolve_expense_receipt_email_alias((select alias_token from email_alias_before))), 0, 'el token anterior ya no resuelve identidad');
select is((select count(*)::integer from public.resolve_expense_receipt_email_alias((select alias_token from email_alias_after))), 1, 'el token vigente resuelve una identidad');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000104';
select throws_ok(
  $$select public.ensure_expense_receipt_email_alias('99000000-0000-0000-0000-000000000001')$$,
  '42501', 'No puedes activar la recepción por correo en esta empresa.', 'no se puede crear alias en otra empresa'
);
reset role;

update public.company_memberships set active = false
where company_id = '99000000-0000-0000-0000-000000000001'
  and user_id = '99000000-0000-0000-0000-000000000102';
set local role service_role;
select is((select count(*)::integer from public.resolve_expense_receipt_email_alias((select alias_token from email_alias_after))), 0, 'una membresía inactiva invalida la recepción de inmediato');
reset role;
update public.company_memberships set active = true
where company_id = '99000000-0000-0000-0000-000000000001'
  and user_id = '99000000-0000-0000-0000-000000000102';
set local role service_role;
select is((select count(*)::integer from public.resolve_expense_receipt_email_alias((select alias_token from email_alias_after))), 1, 'al reactivar la membresía vuelve a resolver el token vigente');

create temporary table empty_attachment_claims as
select n, claim.*
from generate_series(1, 20) n
cross join lateral public.claim_expense_receipt_email_event(
  '99000000-0000-0000-0000-000000000105',
  '99000000-0000-0000-0000-000000000002',
  'event-empty-' || n, 'email-empty-' || n, 0
) claim;
select is(
  (select count(*)::integer from empty_attachment_claims where result = 'CLAIMED'),
  20, 'los correos sin adjuntos también se reclaman y cuentan'
);
select is(
  (select count(*)::integer from empty_attachment_claims where claim_token is not null),
  20, 'cada correo vacío obtiene una lease durable antes de descartarse'
);
select is(
  (select result from public.claim_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000105',
    '99000000-0000-0000-0000-000000000002',
    'event-empty-21', 'email-empty-21', 0
  )),
  'RATE_LIMITED', 'el correo vacío número 21 se rechaza sin consultar al proveedor'
);
select is(
  (select result from public.claim_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000105',
    '99000000-0000-0000-0000-000000000002',
    'event-empty-replay', 'email-empty-1', 0
  )),
  'IN_PROGRESS', 'un replay de correo vacío tampoco evade la deduplicación'
);

insert into public.expense_receipt_captures (
  company_id, uploaded_by, source, storage_path, original_filename,
  mime_type, file_size, checksum_sha256
)
select
  '99000000-0000-0000-0000-000000000001',
  '99000000-0000-0000-0000-000000000103',
  'WEB_UPLOAD',
  '99000000-0000-0000-0000-000000000001/99000000-0000-0000-0000-000000000103/inbox/quota-' || n || '.pdf',
  'cupo-' || n || '.pdf', 'application/pdf', 1000,
  lpad(to_hex(n), 64, '0')
from generate_series(1, 49) as n;
select throws_ok(
  $$select * from public.claim_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000103',
    '99000000-0000-0000-0000-000000000001',
    'event-sin-cupo', 'email-sin-cupo', 2
  )$$,
  '54000', 'Tu bandeja no tiene cupo para este correo.', 'la reserva rechaza exceso de cupo antes de descargar archivos'
);

create temporary table byte_claim_one as
select * from public.claim_expense_receipt_email_event(
  '99000000-0000-0000-0000-000000000104',
  '99000000-0000-0000-0000-000000000002',
  'event-bytes-uno', 'email-bytes-uno', 1
);
select is((select result from byte_claim_one), 'CLAIMED', 'el primer correo entra en la cuota horaria');
select is(
  public.reserve_expense_receipt_email_bytes(
    '99000000-0000-0000-0000-000000000104',
    '99000000-0000-0000-0000-000000000002',
    'email-bytes-uno', (select claim_token from byte_claim_one), 104857600
  ),
  true, 'la cuota contabiliza hasta 100 MiB por hora'
);
create temporary table byte_claim_two as
select * from public.claim_expense_receipt_email_event(
  '99000000-0000-0000-0000-000000000104',
  '99000000-0000-0000-0000-000000000002',
  'event-bytes-dos', 'email-bytes-dos', 1
);
select is((select result from byte_claim_two), 'CLAIMED', 'un correo nuevo se reclama antes de conocer sus bytes');
select is(
  public.reserve_expense_receipt_email_bytes(
    '99000000-0000-0000-0000-000000000104',
    '99000000-0000-0000-0000-000000000002',
    'email-bytes-dos', (select claim_token from byte_claim_two), 1
  ),
  false, 'un byte adicional se rechaza antes de iniciar la descarga'
);
select is(
  (select result from public.claim_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000104',
    '99000000-0000-0000-0000-000000000002',
    'event-bytes-dos-replay', 'email-bytes-dos', 1
  )),
  'RATE_LIMITED', 'el evento rechazado no se reprocesa ni evade la cuota'
);

create temporary table byte_retry_claim_one as
select * from public.claim_expense_receipt_email_event(
  '99000000-0000-0000-0000-000000000102',
  '99000000-0000-0000-0000-000000000001',
  'event-byte-retry-uno', 'email-byte-retry', 1
);
select is((select result from byte_retry_claim_one), 'CLAIMED', 'el intento inicial obtiene una lease para descargar');
select is(
  public.reserve_expense_receipt_email_bytes(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'email-byte-retry', (select claim_token from byte_retry_claim_one), 62914560
  ),
  true, 'el intento inicial contabiliza 60 MiB antes de descargar'
);
select lives_ok(
  $$select public.release_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'email-byte-retry',
    (select claim_token from byte_retry_claim_one)
  )$$,
  'un fallo posterior a la descarga libera la lease'
);
create temporary table byte_retry_claim_two as
select * from public.claim_expense_receipt_email_event(
  '99000000-0000-0000-0000-000000000102',
  '99000000-0000-0000-0000-000000000001',
  'event-byte-retry-dos', 'email-byte-retry', 1
);
select is((select result from byte_retry_claim_two), 'CLAIMED', 'el reintento obtiene una lease nueva');
select isnt(
  (select claim_token from byte_retry_claim_two),
  (select claim_token from byte_retry_claim_one),
  'la cuota de bytes queda asociada a un intento nuevo'
);
select is(
  public.reserve_expense_receipt_email_bytes(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'email-byte-retry', (select claim_token from byte_retry_claim_two), 62914560
  ),
  false, 'el reintento vuelve a cobrar bytes y no puede superar 100 MiB por hora'
);
select is(
  (select result from public.claim_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'event-byte-retry-tres', 'email-byte-retry', 1
  )),
  'RATE_LIMITED', 'el reintento que excede tráfico queda cerrado sin descargar'
);

create temporary table retry_claim_one as
select * from public.claim_expense_receipt_email_event(
  '99000000-0000-0000-0000-000000000102',
  '99000000-0000-0000-0000-000000000001',
  'event-reintento-uno', 'email-reintento', 1
);
select is(
  (select result from retry_claim_one),
  'CLAIMED', 'un evento nuevo obtiene una lease'
);
select lives_ok(
  $$select public.release_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'email-reintento',
    (select claim_token from retry_claim_one)
  )$$,
  'un fallo libera la reserva sin perder el evento'
);
create temporary table retry_claim_two as
select * from public.claim_expense_receipt_email_event(
  '99000000-0000-0000-0000-000000000102',
  '99000000-0000-0000-0000-000000000001',
  'event-reintento-dos', 'email-reintento', 1
);
select is(
  (select result from retry_claim_two),
  'CLAIMED', 'un reintento recupera la lease liberada'
);
select isnt(
  (select claim_token from retry_claim_two),
  (select claim_token from retry_claim_one),
  'cada intento recibe un token de fencing distinto'
);
select throws_ok(
  $$select public.register_inbound_expense_receipt_capture(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    '99000000-0000-0000-0000-000000000001/99000000-0000-0000-0000-000000000102/inbox/99000000-0000-0000-0000-000000000598.pdf',
    'worker-antiguo.pdf', 'application/pdf', 1000,
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    'email-reintento:worker-antiguo', 'email-reintento',
    (select claim_token from retry_claim_one)
  )$$,
  '23514', 'El evento de correo no tiene una reserva activa.', 'un worker antiguo no puede registrar con la lease renovada'
);
select throws_ok(
  $$select public.complete_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'email-reintento',
    (select claim_token from retry_claim_one)
  )$$,
  '23514', 'Evento de correo no reclamado por este intento.', 'un worker antiguo no puede completar la lease renovada'
);
select lives_ok(
  $$select public.release_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'email-reintento',
    (select claim_token from retry_claim_one)
  )$$,
  'un worker antiguo no puede liberar la lease renovada'
);
select is(
  (select result from public.claim_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'event-reintento-tres', 'email-reintento', 1
  )),
  'IN_PROGRESS', 'la lease nueva sigue vigente después del worker antiguo'
);
select lives_ok(
  $$select public.complete_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'email-reintento',
    (select claim_token from retry_claim_two)
  )$$,
  'el reintento recuperado puede cerrarse'
);

create temporary table email_claim as
select * from public.claim_expense_receipt_email_event(
  '99000000-0000-0000-0000-000000000102',
  '99000000-0000-0000-0000-000000000001',
  'event-uno', 'email-uno', 1
);
select is(
  (select result from email_claim),
  'CLAIMED', 'el correo se reclama antes de consultar adjuntos'
);
select is(
  (select result from public.claim_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'event-uno', 'email-uno', 1
  )),
  'IN_PROGRESS', 'un replay concurrente no vuelve a procesar el correo'
);
select is(
  public.reserve_expense_receipt_email_bytes(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'email-uno', (select claim_token from email_claim), 1000
  ),
  true, 'los bytes se reservan antes de descargar el adjunto'
);

select throws_ok(
  $$select public.register_inbound_expense_receipt_capture(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    '99000000-0000-0000-0000-000000000001/99000000-0000-0000-0000-000000000102/inbox/99000000-0000-0000-0000-000000000501.pdf',
    'boleta.pdf', 'application/pdf', 1000,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'email-uno:attachment-uno',
    'email-uno',
    (select claim_token from email_claim)
  )$$,
  '23503', 'El archivo no existe en el almacenamiento privado.', 'no se registra metadata sin objeto privado'
);

insert into storage.objects (id, bucket_id, name, owner_id, metadata)
values (
  '99000000-0000-0000-0000-000000000501', 'expense-receipts',
  '99000000-0000-0000-0000-000000000001/99000000-0000-0000-0000-000000000102/inbox/99000000-0000-0000-0000-000000000501.pdf',
  '99000000-0000-0000-0000-000000000102', '{"mimetype":"application/pdf","size":1000}'::jsonb
);
select lives_ok(
  $$select public.register_inbound_expense_receipt_capture(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    '99000000-0000-0000-0000-000000000001/99000000-0000-0000-0000-000000000102/inbox/99000000-0000-0000-0000-000000000501.pdf',
    'boleta.pdf', 'application/pdf', 1000,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'email-uno:attachment-uno',
    'email-uno',
    (select claim_token from email_claim)
  )$$,
  'el webhook registra el comprobante EMAIL'
);
reset role;
select is(
  (select consumed_slots::integer from public.expense_receipt_email_events where provider_email_id = 'email-uno'),
  1,
  'el registro consume exactamente un espacio reservado'
);
set local role service_role;
select lives_ok(
  $$select public.register_inbound_expense_receipt_capture(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    '99000000-0000-0000-0000-000000000001/99000000-0000-0000-0000-000000000102/inbox/99000000-0000-0000-0000-000000000599.pdf',
    'reintento.pdf', 'application/pdf', 1000,
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'email-uno:attachment-uno',
    'email-uno',
    (select claim_token from email_claim)
  )$$,
  'un reintento idempotente no necesita volver a subir el objeto'
);
select is((select count(*)::integer from public.expense_receipt_captures where source = 'EMAIL'), 1, 'el reintento no crea duplicados');
select is((select external_message_id from public.expense_receipt_captures where source = 'EMAIL'), 'email-uno:attachment-uno', 'se conserva la clave externa exacta');
select lives_ok(
  $$select public.complete_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'email-uno',
    (select claim_token from email_claim)
  )$$,
  'el evento queda completado después de registrar sus adjuntos'
);
select is(
  (select result from public.claim_expense_receipt_email_event(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    'event-uno-replay', 'email-uno', 1
  )),
  'COMPLETED', 'un replay completado no reserva ni descarga nuevamente'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000102';
select is((select count(*)::integer from public.expense_receipt_captures where source = 'EMAIL'), 1, 'el dueño ve la captura recibida por correo');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000103';
select is((select count(*)::integer from public.expense_receipt_captures where source = 'EMAIL'), 0, 'otro miembro no ve la captura recibida');
reset role;

set local role service_role;
select throws_ok(
  $$select public.register_inbound_expense_receipt_capture(
    '99000000-0000-0000-0000-000000000102',
    '99000000-0000-0000-0000-000000000001',
    '99000000-0000-0000-0000-000000000002/99000000-0000-0000-0000-000000000102/inbox/99000000-0000-0000-0000-000000000502.png',
    'ajena.png', 'image/png', 1000,
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'email-dos:attachment-dos',
    'email-dos',
    '99000000-0000-0000-0000-000000000999'
  )$$,
  '42501', 'La ruta de captura no corresponde a la empresa y usuario.', 'la ruta no puede cambiar de tenant'
);

select * from finish();
rollback;
