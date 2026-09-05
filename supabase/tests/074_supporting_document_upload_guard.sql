-- P0-A: protocolo seguro y atómico para documentos laborales privados.
create extension if not exists pgtap;
begin;
select plan(48);
set local request.jwt.claim.aal = 'aal2';

select has_table('public', 'supporting_document_upload_intents', '1) existen reservas de upload');
select has_table('public', 'supporting_document_upload_limits', '2) existe cuota distribuida');
select has_function('public', 'reserve_supporting_document_upload', array['uuid','text','text','integer'], '3) existe RPC de reserva');
select has_function('public', 'register_supporting_document_upload', array['uuid','text','text','uuid','uuid','uuid'], '4) existe RPC de commit genérico');
select has_function('public', 'create_pending_medical_license', array['uuid','text','date','date','text'], '5) existe RPC atómico de licencia');
select ok(not (select public from storage.buckets where id = 'supporting-documents'), '6) bucket privado');
select is((select file_size_limit from storage.buckets where id = 'supporting-documents'), 10485760::bigint, '7) Storage impone 10 MiB');
select ok(
  (select allowed_mime_types @> array['application/pdf','image/jpeg','image/png'] from storage.buckets where id = 'supporting-documents'),
  '8) Storage solo admite los tres MIME esperados'
);
select ok(not has_table_privilege('authenticated', 'public.supporting_document_upload_intents', 'SELECT'), '9) reservas no son legibles directamente');
select ok(not has_table_privilege('authenticated', 'public.supporting_documents', 'INSERT'), '10) metadata no se compone saltando el RPC');
select ok(not has_table_privilege('authenticated', 'public.medical_license_approvals', 'INSERT'), '11) pendientes médicas no se componen saltando el RPC');
select ok(not has_function_privilege('anon', 'public.reserve_supporting_document_upload(uuid,text,text,integer)', 'EXECUTE'), '12) anon no reserva');
select ok(has_function_privilege('authenticated', 'public.reserve_supporting_document_upload(uuid,text,text,integer)', 'EXECUTE'), '13) authenticated usa el RPC cerrado');
select ok(exists (
  select 1 from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='supporting_documents_storage_insert' and cmd='INSERT'
), '14) upload requiere policy de reserva');
select ok(exists (
  select 1 from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='supporting_documents_storage_delete_orphan' and cmd='DELETE'
), '15) existe compensación solo para huérfanos');

insert into public.profiles (id, display_name, role, active) values
  ('74000000-0000-0000-0000-000000000001', 'Supervisor documento', 'SUPERVISOR_PRODUCTION', true),
  ('74000000-0000-0000-0000-000000000002', 'Supervisor ajeno', 'SUPERVISOR_INSTALLATION', true);
insert into public.employees (id, external_workera_id, first_name, last_name, display_name, employee_group_id) values
  ('74000000-0000-0000-0000-000000000101', 'DOC-GUARD-PROD', 'Doc', 'Producción', 'Doc Producción',
    (select id from public.employee_groups where code='PRODUCTION')),
  ('74000000-0000-0000-0000-000000000102', 'DOC-GUARD-INST', 'Doc', 'Instalación', 'Doc Instalación',
    (select id from public.employee_groups where code='INSTALLATION'));

create temporary table test_document_reservations (
  label text primary key, intent_id uuid not null, storage_path text not null
);
create temporary table test_registered_documents (label text primary key, document_id uuid not null);
create temporary table test_medical_result (
  approval_id uuid, absence_record_id uuid, document_id uuid
);
grant all on test_document_reservations, test_registered_documents, test_medical_result to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select throws_ok(
  $$select * from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000101','text/html','html',100)$$,
  '22023', null, '16) formato activo no se reserva'
);
select throws_ok(
  $$select * from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000101','image/jpeg','pdf',100)$$,
  '22023', null, '17) MIME y extensión deben coincidir'
);
select throws_ok(
  $$select * from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000101','application/pdf','pdf',10485761)$$,
  '22023', null, '18) más de 10 MiB se niega en DB'
);
select throws_ok(
  $$select * from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000102','application/pdf','pdf',100)$$,
  '42501', null, '19) supervisor no reserva para otra área'
);
select lives_ok(
  $$insert into test_document_reservations select 'main', r.*
    from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000101','application/pdf','pdf',100) r$$,
  '20) reserva válida vive'
);
reset role;

select is((select count(*)::integer from public.supporting_document_upload_intents where actor_id='74000000-0000-0000-0000-000000000001'), 1, '21) una reserva durable');
select matches((select storage_path from test_document_reservations where label='main'),
  '^74000000-0000-0000-0000-000000000101/[0-9a-f-]+\.pdf$', '22) ruta bajo empleado y extensión canónica');
select ok((select storage_path not like '%certificado%' from test_document_reservations where label='main'), '23) filename sensible no aparece en ruta');

set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select ok(public.can_upload_supporting_document_path((select storage_path from test_document_reservations where label='main'),'application/pdf','100'), '24) dueño usa su reserva exacta');
select ok(not public.can_upload_supporting_document_path((select storage_path from test_document_reservations where label='main'),'application/pdf','10000000'), '24b) no puede reservar pocos bytes y subir más');
select ok(not public.can_upload_supporting_document_path('74000000-0000-0000-0000-000000000101/no-reservado.pdf','application/pdf','100'), '25) ruta inventada no pasa');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000002';
select ok(not public.can_upload_supporting_document_path((select storage_path from test_document_reservations where label='main'),'application/pdf','100'), '26) otra sesión no roba la reserva');
select throws_ok(
  $$insert into public.supporting_documents (employee_id,document_type,storage_path,mime_type,original_filename,uploaded_by)
    values ('74000000-0000-0000-0000-000000000102','OTHER','inventado.pdf','application/pdf','inventado.pdf','74000000-0000-0000-0000-000000000002')$$,
  '42501', null, '27) metadata directa está revocada'
);
reset role;

insert into storage.objects (id,bucket_id,name,owner_id,metadata)
select gen_random_uuid(),'supporting-documents',storage_path,'74000000-0000-0000-0000-000000000001',
       '{"mimetype":"application/pdf","size":100}'::jsonb
from test_document_reservations where label='main';

set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select lives_ok(
  $$insert into test_registered_documents
    select 'main', public.register_supporting_document_upload(intent_id,'OTHER','certificado personal.pdf')
    from test_document_reservations where label='main'$$,
  '28) commit genérico vive después de existir el objeto'
);
reset role;
select ok(exists (
  select 1 from public.supporting_documents d join test_registered_documents t on t.document_id=d.id
  where t.label='main' and d.employee_id='74000000-0000-0000-0000-000000000101'
    and d.mime_type='application/pdf' and d.original_filename='certificado personal.pdf'
), '29) metadata deriva de la reserva y conserva filename solo en DB');
select ok((select consumed_at is not null from public.supporting_document_upload_intents where id=(select intent_id from test_document_reservations where label='main')), '30) reserva queda consumida');
select ok(exists (
  select 1 from public.audit_log a join test_registered_documents t on t.document_id=a.entity_id
  where a.action='SUPPORTING_DOCUMENT_UPLOADED'
), '31) upload queda auditado');

set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select ok(not public.can_delete_orphan_supporting_document_path((select storage_path from test_document_reservations where label='main')), '32) documento registrado es inmutable');
select throws_ok(
  $$select public.register_supporting_document_upload(intent_id,'OTHER','replay.pdf') from test_document_reservations where label='main'$$,
  '42501', null, '33) una reserva no se consume dos veces'
);
select lives_ok(
  $$insert into test_document_reservations select 'orphan', r.*
    from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000101','image/jpeg','jpg',100) r$$,
  '34) segunda reserva para probar compensación'
);
reset role;
insert into storage.objects (id,bucket_id,name,owner_id,metadata)
select gen_random_uuid(),'supporting-documents',storage_path,'74000000-0000-0000-0000-000000000001',
       '{"mimetype":"image/jpeg","size":100}'::jsonb
from test_document_reservations where label='orphan';
set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select ok(public.can_delete_orphan_supporting_document_path((select storage_path from test_document_reservations where label='orphan')), '35) objeto sin metadata puede compensarse');
reset role;
select ok((select qual::text like '%can_delete_orphan_supporting_document_path%'
  from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='supporting_documents_storage_delete_orphan'),
  '36) la policy de Storage delega en el helper de huérfanos');
set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000002';
select ok(not public.can_delete_orphan_supporting_document_path((select storage_path from test_document_reservations where label='orphan')), '37) otra sesión no puede borrar el huérfano');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select throws_ok(
  $$insert into storage.objects (id,bucket_id,name,owner_id,metadata)
    values (gen_random_uuid(),'supporting-documents','74000000-0000-0000-0000-000000000101/no-reservado.pdf',auth.uid(),'{"mimetype":"application/pdf","size":100}')$$,
  '42501', null, '38) Storage directo sin reserva falla por RLS'
);
select lives_ok(
  $$insert into test_document_reservations select 'expired', r.*
    from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000101','application/pdf','pdf',100) r$$,
  '39) reserva que luego vencerá'
);
reset role;
update public.supporting_document_upload_intents set expires_at=clock_timestamp()-interval '1 second'
where id=(select intent_id from test_document_reservations where label='expired');
set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select throws_ok(
  $$select public.register_supporting_document_upload(intent_id,'OTHER','expired.pdf') from test_document_reservations where label='expired'$$,
  '42501', null, '40) reserva vencida no registra metadata'
);
select lives_ok(
  $$insert into test_document_reservations select 'medical', r.*
    from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000101','application/pdf','pdf',200) r$$,
  '41) reserva para licencia médica'
);
reset role;
insert into storage.objects (id,bucket_id,name,owner_id,metadata)
select gen_random_uuid(),'supporting-documents',storage_path,'74000000-0000-0000-0000-000000000001',
       '{"mimetype":"application/pdf","size":200}'::jsonb
from test_document_reservations where label='medical';
set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select lives_ok(
  $$insert into test_medical_result
    select * from public.create_pending_medical_license(
      (select intent_id from test_document_reservations where label='medical'),
      'licencia.pdf', date '2026-09-01', date '2026-09-03', 'EXTRAIDO'
    )$$,
  '42) licencia crea su grafo en un commit atómico'
);
reset role;
select ok(exists (
  select 1 from test_medical_result r
  join public.medical_license_approvals a on a.id=r.approval_id and a.absence_record_id=r.absence_record_id and a.supporting_document_id=r.document_id
  join public.absence_records ar on ar.id=r.absence_record_id
  join public.supporting_documents d on d.id=r.document_id and d.absence_record_id=r.absence_record_id
), '43) ausencia, documento y aprobación quedan enlazados');
select is((select a.status::text from public.medical_license_approvals a join test_medical_result r on r.approval_id=a.id), 'PENDING_RRHH_APPROVAL', '44) upload jamás autoaprueba');
select is((select d.document_type from public.supporting_documents d join test_medical_result r on r.document_id=d.id), 'MEDICAL_CERTIFICATE', '45) documento médico conserva tipo autoritativo');

insert into public.supporting_document_upload_limits(actor_id,window_started_at,request_count,byte_count)
values ('74000000-0000-0000-0000-000000000001',date_trunc('hour',clock_timestamp()),30,1)
on conflict(actor_id) do update set window_started_at=excluded.window_started_at,request_count=excluded.request_count,byte_count=excluded.byte_count;
set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select throws_ok(
  $$select * from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000101','application/pdf','pdf',1)$$,
  'P0001', null, '46) 30 documentos por hora es límite distribuido'
);
reset role;
update public.supporting_document_upload_limits
set request_count=0, byte_count=104857600
where actor_id='74000000-0000-0000-0000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '74000000-0000-0000-0000-000000000001';
select throws_ok(
  $$select * from public.reserve_supporting_document_upload('74000000-0000-0000-0000-000000000101','application/pdf','pdf',1)$$,
  'P0001', null, '47) 100 MiB por hora también limita volumen'
);
reset role;

select * from finish();
rollback;
