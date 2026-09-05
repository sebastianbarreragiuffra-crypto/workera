-- P0-A: recoleccion segura de uploads laborales abandonados.
create extension if not exists pgtap;

begin;
select plan(50);

select has_table('public', 'supporting_document_upload_intents', 'conserva el ledger de reservas');
select has_column('public', 'supporting_document_upload_intents', 'cleanup_attempt', 'registra intentos de limpieza');
select has_column('public', 'supporting_document_upload_intents', 'cleanup_available_at', 'registra disponibilidad');
select has_column('public', 'supporting_document_upload_intents', 'cleanup_locked_at', 'registra inicio de lease');
select has_column('public', 'supporting_document_upload_intents', 'cleanup_locked_by', 'registra fencing token');
select has_column('public', 'supporting_document_upload_intents', 'cleanup_completed_at', 'registra termino');
select has_column('public', 'supporting_document_upload_intents', 'cleanup_result', 'registra resultado terminal');
select has_column('public', 'supporting_document_upload_intents', 'cleanup_error_code', 'registra solo codigo seguro');
select has_function('public', 'claim_expired_supporting_document_uploads', array['uuid','integer','integer'], 'existe claim SKIP LOCKED');
select has_function('public', 'complete_supporting_document_orphan_cleanup', array['uuid','uuid','text'], 'existe cierre fenced');
select has_function('public', 'fail_supporting_document_orphan_cleanup', array['uuid','uuid','text','boolean','integer'], 'existe retry acotado');
select has_function('public', 'reclaim_stale_supporting_document_cleanups', array['integer'], 'existe recuperacion de leases');
select ok(
  not has_function_privilege('authenticated', 'public.claim_expired_supporting_document_uploads(uuid,integer,integer)', 'EXECUTE'),
  'el navegador no reclama rutas privadas'
);
select ok(
  not has_function_privilege('authenticated', 'public.complete_supporting_document_orphan_cleanup(uuid,uuid,text)', 'EXECUTE'),
  'el navegador no inventa limpiezas'
);
select ok(
  not has_function_privilege('authenticated', 'public.fail_supporting_document_orphan_cleanup(uuid,uuid,text,boolean,integer)', 'EXECUTE'),
  'el navegador no manipula reintentos'
);
select ok(
  has_function_privilege('service_role', 'public.claim_expired_supporting_document_uploads(uuid,integer,integer)', 'EXECUTE'),
  'solo el worker privilegiado reclama'
);
select has_index(
  'public', 'supporting_document_upload_intents',
  'supporting_document_upload_intents_pending_idx',
  'la cola pendiente tiene indice parcial'
);
select ok(exists (
  select 1 from pg_constraint
  where conname = 'supporting_document_upload_intents_cleanup_lock_chk'
), 'lease exige timestamp y worker juntos');
select ok(exists (
  select 1 from pg_constraint
  where conname = 'supporting_document_upload_intents_cleanup_completion_chk'
), 'resultado terminal exige fecha y lease cerrado');

insert into public.profiles (id, display_name, role, active)
values ('79000000-0000-0000-0000-000000000001', 'Actor sweeper', 'ADMIN_RRHH', true);
insert into public.employees (
  id, external_workera_id, first_name, last_name, display_name, employee_group_id
) values (
  '79000000-0000-0000-0000-000000000101', 'SWEEPER-EMP', 'Test', 'Sweeper', 'Test Sweeper',
  (select id from public.employee_groups where code = 'ADMINISTRATION')
);

insert into public.supporting_document_upload_intents (
  id, actor_id, employee_id, storage_path, mime_type, file_size,
  created_at, expires_at, consumed_at
) values
  ('79000000-0000-0000-0000-000000000201', '79000000-0000-0000-0000-000000000001', '79000000-0000-0000-0000-000000000101', '79000000-0000-0000-0000-000000000101/expired.pdf', 'application/pdf', 100, now()-interval '30 minutes', now()-interval '20 minutes', null),
  ('79000000-0000-0000-0000-000000000202', '79000000-0000-0000-0000-000000000001', '79000000-0000-0000-0000-000000000101', '79000000-0000-0000-0000-000000000101/fresh.pdf', 'application/pdf', 100, now(), now()+interval '10 minutes', null),
  ('79000000-0000-0000-0000-000000000203', '79000000-0000-0000-0000-000000000001', '79000000-0000-0000-0000-000000000101', '79000000-0000-0000-0000-000000000101/grace.pdf', 'application/pdf', 100, now()-interval '12 minutes', now()-interval '2 minutes', null),
  ('79000000-0000-0000-0000-000000000204', '79000000-0000-0000-0000-000000000001', '79000000-0000-0000-0000-000000000101', '79000000-0000-0000-0000-000000000101/consumed.pdf', 'application/pdf', 100, now()-interval '30 minutes', now()-interval '20 minutes', now()-interval '15 minutes'),
  ('79000000-0000-0000-0000-000000000205', '79000000-0000-0000-0000-000000000001', '79000000-0000-0000-0000-000000000101', '79000000-0000-0000-0000-000000000101/protected.pdf', 'application/pdf', 100, now()-interval '30 minutes', now()-interval '20 minutes', null);

insert into public.supporting_documents (
  id, employee_id, document_type, storage_path, mime_type,
  original_filename, uploaded_by
) values (
  '79000000-0000-0000-0000-000000000301',
  '79000000-0000-0000-0000-000000000101', 'OTHER',
  '79000000-0000-0000-0000-000000000101/protected.pdf',
  'application/pdf', 'protected.pdf',
  '79000000-0000-0000-0000-000000000001'
);

set local role service_role;
select throws_ok(
  $$select * from public.claim_expired_supporting_document_uploads(null, 20, 300)$$,
  '22023', 'worker_id y limit valido son obligatorios.',
  'worker nulo se rechaza'
);
select throws_ok(
  $$select * from public.claim_expired_supporting_document_uploads('79000000-0000-0000-0000-000000000901', 101, 300)$$,
  '22023', 'worker_id y limit valido son obligatorios.',
  'lote excesivo se rechaza'
);
select throws_ok(
  $$select * from public.claim_expired_supporting_document_uploads('79000000-0000-0000-0000-000000000901', 20, 59)$$,
  '22023', 'grace_seconds debe estar entre 60 y 86400.',
  'gracia insegura se rechaza'
);
create temporary table first_cleanup as
select * from public.claim_expired_supporting_document_uploads(
  '79000000-0000-0000-0000-000000000901', 20, 300
);
select is((select count(*)::integer from first_cleanup), 1, 'claim toma solo un huerfano vencido');
select is((select intent_id from first_cleanup), '79000000-0000-0000-0000-000000000201'::uuid, 'la ruta elegida es la reserva expirada');
select ok((
  select cleanup_attempt = 1
    and cleanup_locked_by = '79000000-0000-0000-0000-000000000901'::uuid
    and cleanup_locked_at is not null
  from public.supporting_document_upload_intents
  where id = '79000000-0000-0000-0000-000000000201'
), 'claim incrementa intento y deja fencing');
select is((
  select count(*)::integer
  from public.claim_expired_supporting_document_uploads(
    '79000000-0000-0000-0000-000000000902', 20, 300
  )
), 0, 'otro worker no roba la lease');
select throws_ok(
  $$select public.complete_supporting_document_orphan_cleanup(
    '79000000-0000-0000-0000-000000000201',
    '79000000-0000-0000-0000-000000000902', 'REMOVED_OR_ABSENT'
  )$$,
  '40001', 'Lease de limpieza inexistente, vencida o protegida.',
  'otro worker no puede cerrar'
);
select throws_ok(
  $$select public.complete_supporting_document_orphan_cleanup(
    '79000000-0000-0000-0000-000000000201',
    '79000000-0000-0000-0000-000000000901', 'REMOVED'
  )$$,
  '22023', 'Resultado de limpieza invalido.',
  'el resultado es allowlisted'
);
select is(
  public.complete_supporting_document_orphan_cleanup(
    '79000000-0000-0000-0000-000000000201',
    '79000000-0000-0000-0000-000000000901', 'REMOVED_OR_ABSENT'
  ),
  'REMOVED_OR_ABSENT',
  'la lease correcta termina'
);
select ok((
  select cleanup_completed_at is not null
    and cleanup_result = 'REMOVED_OR_ABSENT'
    and cleanup_locked_by is null
  from public.supporting_document_upload_intents
  where id = '79000000-0000-0000-0000-000000000201'
), 'el estado terminal queda consistente');
select ok(exists (
  select 1 from public.audit_log
  where action = 'SUPPORTING_DOCUMENT_ORPHAN_CLEANED'
    and entity_id = '79000000-0000-0000-0000-000000000201'
), 'la limpieza queda auditada');
select ok(not exists (
  select 1 from public.audit_log
  where entity_id = '79000000-0000-0000-0000-000000000201'
    and metadata ? 'storage_path'
), 'la auditoria nunca copia la ruta sensible');
select throws_ok(
  $$select public.complete_supporting_document_orphan_cleanup(
    '79000000-0000-0000-0000-000000000201',
    '79000000-0000-0000-0000-000000000901', 'REMOVED_OR_ABSENT'
  )$$,
  '40001', 'Lease de limpieza inexistente, vencida o protegida.',
  'el cierre no admite replay'
);
select is((select cleanup_attempt from public.supporting_document_upload_intents where id='79000000-0000-0000-0000-000000000202'), 0, 'reserva vigente no se reclama');
select is((select cleanup_attempt from public.supporting_document_upload_intents where id='79000000-0000-0000-0000-000000000203'), 0, 'reserva dentro de gracia no se reclama');
select is((select cleanup_attempt from public.supporting_document_upload_intents where id='79000000-0000-0000-0000-000000000204'), 0, 'reserva consumida no se reclama');
select is((select cleanup_attempt from public.supporting_document_upload_intents where id='79000000-0000-0000-0000-000000000205'), 0, 'ruta con metadata registrada queda protegida');

reset role;
insert into public.supporting_document_upload_intents (
  id, actor_id, employee_id, storage_path, mime_type, file_size, created_at, expires_at
) values (
  '79000000-0000-0000-0000-000000000206', '79000000-0000-0000-0000-000000000001',
  '79000000-0000-0000-0000-000000000101', '79000000-0000-0000-0000-000000000101/retry.pdf',
  'application/pdf', 100, now()-interval '30 minutes', now()-interval '20 minutes'
);
set local role service_role;
select is((select count(*)::integer from public.claim_expired_supporting_document_uploads('79000000-0000-0000-0000-000000000903', 1, 300)), 1, 'un nuevo huerfano entra a retry');
select is(public.fail_supporting_document_orphan_cleanup(
  '79000000-0000-0000-0000-000000000206', '79000000-0000-0000-0000-000000000903',
  'STORAGE_TIMEOUT', true, 1
), true, 'fallo transitorio vuelve a cola');
select ok((
  select cleanup_completed_at is null and cleanup_result is null
    and cleanup_locked_by is null and cleanup_error_code = 'STORAGE_TIMEOUT'
  from public.supporting_document_upload_intents
  where id='79000000-0000-0000-0000-000000000206'
), 'retry conserva evidencia segura sin quedar terminal');
reset role;
update public.supporting_document_upload_intents set cleanup_available_at=now()-interval '1 second'
where id='79000000-0000-0000-0000-000000000206';
set local role service_role;
select is((select count(*)::integer from public.claim_expired_supporting_document_uploads('79000000-0000-0000-0000-000000000904', 1, 300)), 1, 'retry vuelve a reclamar con nueva lease');
select is(public.fail_supporting_document_orphan_cleanup(
  '79000000-0000-0000-0000-000000000206', '79000000-0000-0000-0000-000000000904',
  'STORAGE_DENIED', false, 1
), false, 'fallo no reintentable termina');
select ok((
  select cleanup_result='FAILED' and cleanup_completed_at is not null
    and cleanup_error_code='STORAGE_DENIED' and cleanup_locked_by is null
  from public.supporting_document_upload_intents
  where id='79000000-0000-0000-0000-000000000206'
), 'fallo terminal queda trazable');
select ok(exists (
  select 1 from public.audit_log
  where action='SUPPORTING_DOCUMENT_ORPHAN_CLEANUP_FAILED'
    and entity_id='79000000-0000-0000-0000-000000000206'
    and metadata->>'error_code'='STORAGE_DENIED'
    and not metadata ? 'storage_path'
), 'auditoria terminal usa solo codigo allowlisted');

reset role;
insert into public.supporting_document_upload_intents (
  id, actor_id, employee_id, storage_path, mime_type, file_size, created_at, expires_at,
  cleanup_attempt, cleanup_locked_at, cleanup_locked_by
) values
  ('79000000-0000-0000-0000-000000000207', '79000000-0000-0000-0000-000000000001', '79000000-0000-0000-0000-000000000101', '79000000-0000-0000-0000-000000000101/stale-retry.pdf', 'application/pdf', 100, now()-interval '30 minutes', now()-interval '20 minutes', 1, now()-interval '10 minutes', '79000000-0000-0000-0000-000000000905'),
  ('79000000-0000-0000-0000-000000000208', '79000000-0000-0000-0000-000000000001', '79000000-0000-0000-0000-000000000101', '79000000-0000-0000-0000-000000000101/stale-exhausted.pdf', 'application/pdf', 100, now()-interval '30 minutes', now()-interval '20 minutes', 3, now()-interval '10 minutes', '79000000-0000-0000-0000-000000000906');
set local role service_role;
select is(public.reclaim_stale_supporting_document_cleanups(300), 2, 'recupera dos workers caidos');
select ok((
  select cleanup_locked_by is null and cleanup_completed_at is null and cleanup_result is null
  from public.supporting_document_upload_intents
  where id='79000000-0000-0000-0000-000000000207'
), 'lease con presupuesto vuelve a cola');
select ok((
  select cleanup_locked_by is null and cleanup_completed_at is not null
    and cleanup_result='FAILED' and cleanup_error_code='LEASE_EXHAUSTED'
  from public.supporting_document_upload_intents
  where id='79000000-0000-0000-0000-000000000208'
), 'lease agotada termina bloqueada');
select ok(exists (
  select 1 from public.audit_log
  where action='SUPPORTING_DOCUMENT_ORPHAN_CLEANUP_FAILED'
    and entity_id='79000000-0000-0000-0000-000000000208'
    and metadata->>'error_code'='LEASE_EXHAUSTED'
), 'agotamiento de lease produce señal auditable');
select throws_ok(
  $$select public.reclaim_stale_supporting_document_cleanups(30)$$,
  '22023', 'stale_after_seconds debe estar entre 60 y 3600.',
  'reclaim valida su ventana'
);
reset role;

select ok(
  not has_function_privilege('anon', 'public.reclaim_stale_supporting_document_cleanups(integer)', 'EXECUTE'),
  'anon tampoco puede activar el barrido'
);

select * from finish();
rollback;
