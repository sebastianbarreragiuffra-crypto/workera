-- P0-A: tenant, MFA, cuota y auditoria en descargas laborales privadas.
create extension if not exists pgtap;
begin;
select plan(53);

select has_table('public', 'workforce_data_access_limits', '1) existe contador distribuido laboral');
select has_column('public', 'workforce_data_access_limits', 'company_id', '2) contador particionado por empresa');
select has_column('public', 'workforce_data_access_limits', 'actor_id', '3) contador particionado por actor');
select has_column('public', 'workforce_data_access_limits', 'scope', '4) contador particionado por superficie');
select has_function('public', 'authorize_supporting_document_download', array['uuid'], '5) existe RPC de entrega');
select has_function('public', 'current_actor_satisfies_mfa', array[]::text[], '6) existe helper MFA para policies');
select has_function('public', 'can_read_supporting_document_employee', array['uuid'], '7) existe gate por trabajador');
select has_function('public', 'can_read_supporting_document_path', array['text'], '8) existe gate de Storage');
select ok(
  has_function_privilege('authenticated', 'public.authorize_supporting_document_download(uuid)', 'EXECUTE'),
  '9) authenticated entra por RPC cerrado'
);
select ok(
  not has_function_privilege('anon', 'public.authorize_supporting_document_download(uuid)', 'EXECUTE'),
  '10) anon no autoriza entregas'
);
select ok(
  not has_table_privilege('authenticated', 'public.workforce_data_access_limits', 'SELECT'),
  '11) navegador no inspecciona cuotas'
);
select ok(
  (select relrowsecurity from pg_class where oid='public.workforce_data_access_limits'::regclass),
  '12) contador tiene RLS deny-by-default'
);
select ok(
  (select qual::text like '%can_read_supporting_document_employee%'
   from pg_policies where schemaname='public' and tablename='supporting_documents'
     and policyname='supporting_documents_select_admin'),
  '13) tabla base delega en gate tenant-aware'
);
select ok(
  (select qual::text like '%can_read_supporting_document_path%'
   from pg_policies where schemaname='storage' and tablename='objects'
     and policyname='supporting_documents_storage_select_admin'),
  '14) Storage delega en gate de ruta registrada'
);
select ok(
  pg_get_viewdef('public.supporting_documents_metadata'::regclass, true)
    ~ 'employee_belongs_to_active_company',
  '15) metadata exige empresa activa en todas sus ramas'
);
select ok(
  pg_get_viewdef('public.supporting_documents_metadata'::regclass, true)
    ~ 'current_actor_satisfies_mfa',
  '16) metadata tambien falla cerrada ante MFA pendiente'
);
select ok(
  pg_get_functiondef('public.authorize_supporting_document_download(uuid)'::regprocedure)
    ~* 'on conflict',
  '17) cuota usa UPSERT atomico'
);
select ok(
  pg_get_functiondef('public.authorize_supporting_document_download(uuid)'::regprocedure)
    ~ 'SUPPORTING_DOCUMENT_DOWNLOAD_AUTHORIZED'
  and pg_get_functiondef('public.authorize_supporting_document_download(uuid)'::regprocedure)
    ~ 'SUPPORTING_DOCUMENT_DOWNLOAD_RATE_LIMITED',
  '18) autorizacion y bloqueo tienen eventos distintos'
);

-- El gate global sigue impidiendo habilitar un segundo workspace laboral hasta
-- aislar TODO el dominio. Solo dentro de esta transaccion de test se retira el
-- CHECK para demostrar que este recorte documental ya funciona con dos tenants;
-- ROLLBACK lo restaura y la migracion nunca relaja el NO-GO global.
alter table public.companies drop constraint companies_workspace_mt3a_gate_chk;

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled) values
  ('75000000-0000-4000-8000-000000000001', 'Documentos Uno', 'Documentos Uno SpA', 'documentos-uno', true, 'ACTIVE', true),
  ('75000000-0000-4000-8000-000000000002', 'Documentos Dos', 'Documentos Dos SpA', 'documentos-dos', true, 'ACTIVE', true);

insert into public.profiles (id, display_name, role, active) values
  ('75000000-0000-4000-8000-000000000101', 'RRHH Uno', 'ADMIN_RRHH', true),
  ('75000000-0000-4000-8000-000000000102', 'RRHH Dos', 'ADMIN_RRHH', true),
  ('75000000-0000-4000-8000-000000000103', 'Supervisor Uno', 'SUPERVISOR_PRODUCTION', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('75000000-0000-4000-8000-000000000201', '75000000-0000-4000-8000-000000000101', '75000000-0000-4000-8000-000000000001', 'ADMIN_RRHH', true),
  ('75000000-0000-4000-8000-000000000202', '75000000-0000-4000-8000-000000000102', '75000000-0000-4000-8000-000000000002', 'ADMIN_RRHH', true),
  ('75000000-0000-4000-8000-000000000203', '75000000-0000-4000-8000-000000000103', '75000000-0000-4000-8000-000000000001', 'SUPERVISOR_PRODUCTION', true);

insert into public.employee_groups (id, company_id, code, name) values
  ('75000000-0000-4000-8000-000000000301', '75000000-0000-4000-8000-000000000001', 'DOC_TENANT_ONE', 'Documentos tenant uno'),
  ('75000000-0000-4000-8000-000000000302', '75000000-0000-4000-8000-000000000002', 'DOC_TENANT_TWO', 'Documentos tenant dos');

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name, employee_group_id
) values
  ('75000000-0000-4000-8000-000000000401', '75000000-0000-4000-8000-000000000001', 'DOC-DL-ONE', 'Persona', 'Uno', 'Persona Uno', '75000000-0000-4000-8000-000000000301'),
  ('75000000-0000-4000-8000-000000000402', '75000000-0000-4000-8000-000000000002', 'DOC-DL-TWO', 'Persona', 'Dos', 'Persona Dos', '75000000-0000-4000-8000-000000000302');

insert into public.supporting_documents (
  id, employee_id, document_type, storage_path, mime_type, original_filename, uploaded_by
) values
  ('75000000-0000-4000-8000-000000000501', '75000000-0000-4000-8000-000000000401', 'MEDICAL_CERTIFICATE',
   '75000000-0000-4000-8000-000000000401/tenant-one.pdf', 'application/pdf', 'licencia uno.pdf',
   '75000000-0000-4000-8000-000000000103'),
  ('75000000-0000-4000-8000-000000000502', '75000000-0000-4000-8000-000000000402', 'MEDICAL_CERTIFICATE',
   '75000000-0000-4000-8000-000000000402/tenant-two.pdf', 'application/pdf', 'licencia dos.pdf',
   '75000000-0000-4000-8000-000000000102');

create temporary table test_document_download (
  allowed boolean, request_limit integer, remaining integer,
  retry_after_seconds integer, storage_path text, original_filename text, mime_type text
);
create temporary table test_document_rate (like test_document_download);
grant all on test_document_download, test_document_rate to authenticated;

-- Un rol privilegiado en AAL1 no puede usar RLS, vista ni RPC.
set local role authenticated;
set local request.jwt.claim.sub = '75000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal1';
select ok(not public.current_actor_satisfies_mfa(), '19) AAL1 no satisface MFA privilegiado');
select ok(not public.can_read_supporting_document_employee('75000000-0000-4000-8000-000000000401'), '20) AAL1 no lee contenido');
select is((select count(*)::integer from public.supporting_documents), 0, '21) tabla base no filtra storage_path en AAL1');
select is((select count(*)::integer from public.supporting_documents_metadata), 0, '22) vista tampoco filtra metadata en AAL1');
select throws_ok(
  $$select * from public.authorize_supporting_document_download('75000000-0000-4000-8000-000000000501')$$,
  '42501', 'Acceso no autorizado.', '23) RPC niega AAL1'
);

-- En AAL2 solo existe el tenant de la membresia vigente.
set local request.jwt.claim.aal = 'aal2';
select ok(public.current_actor_satisfies_mfa(), '24) AAL2 satisface MFA');
select ok(public.can_read_supporting_document_employee('75000000-0000-4000-8000-000000000401'), '25) RRHH lee trabajador de su empresa');
select ok(not public.can_read_supporting_document_employee('75000000-0000-4000-8000-000000000402'), '26) RRHH no lee trabajador de otra empresa');
select ok(public.can_read_supporting_document_path('75000000-0000-4000-8000-000000000401/tenant-one.pdf'), '27) ruta registrada propia pasa');
select ok(not public.can_read_supporting_document_path('75000000-0000-4000-8000-000000000402/tenant-two.pdf'), '28) ruta registrada ajena no pasa');
select is((select count(*)::integer from public.supporting_documents), 1, '29) RLS base devuelve solo un tenant');
select is((select count(*)::integer from public.supporting_documents_metadata), 1, '30) vista devuelve solo un tenant');
select lives_ok(
  $$insert into test_document_download
    select * from public.authorize_supporting_document_download('75000000-0000-4000-8000-000000000501')$$,
  '31) primera autorizacion vive'
);
select ok((select allowed from test_document_download), '32) primera entrega permitida');
select is((select request_limit from test_document_download), 60, '33) limite tolera interfaz normal');
select is((select remaining from test_document_download), 59, '34) entrega consume una unidad');
select is((select retry_after_seconds from test_document_download), 0, '35) entrega permitida no pide espera');
select is((select storage_path from test_document_download), '75000000-0000-4000-8000-000000000401/tenant-one.pdf', '36) ruta pertenece al documento autorizado');
select is((select original_filename from test_document_download), 'licencia uno.pdf', '37) filename sale solo tras autorizar');
select is((select mime_type from test_document_download), 'application/pdf', '38) MIME sale solo tras autorizar');
reset role;
select is(
  (select count(*)::integer from public.audit_log
   where actor_id='75000000-0000-4000-8000-000000000101'
     and entity_id='75000000-0000-4000-8000-000000000501'
     and action='SUPPORTING_DOCUMENT_DOWNLOAD_AUTHORIZED'
     and metadata->>'company_id'='75000000-0000-4000-8000-000000000001'),
  1, '39) autorizacion liga actor, empresa y documento'
);

-- Un supervisor conserva metadata propia, pero nunca el contenido.
set local role authenticated;
set local request.jwt.claim.sub = '75000000-0000-4000-8000-000000000103';
set local request.jwt.claim.aal = 'aal2';
select ok(not public.can_read_supporting_document_employee('75000000-0000-4000-8000-000000000401'), '40) supervisor no lee bytes');
select is((select count(*)::integer from public.supporting_documents), 0, '41) tabla base no expone storage_path al supervisor');
select is((select count(*)::integer from public.supporting_documents_metadata), 1, '42) autor conserva metadata sin ruta');
select throws_ok(
  $$select * from public.authorize_supporting_document_download('75000000-0000-4000-8000-000000000501')$$,
  '42501', 'Acceso no autorizado.', '43) supervisor no salta el gate por RPC'
);

-- Un RRHH de otra empresa tampoco puede confirmar que el documento existe.
set local request.jwt.claim.sub = '75000000-0000-4000-8000-000000000102';
select throws_ok(
  $$select * from public.authorize_supporting_document_download('75000000-0000-4000-8000-000000000501')$$,
  '42501', 'Acceso no autorizado.', '44) RRHH de otro tenant queda fuera'
);
reset role;

-- Revocar membresia corta tanto contenido como metadata sin cambiar el rol.
update public.company_memberships set active=false
where id='75000000-0000-4000-8000-000000000201';
set local role authenticated;
set local request.jwt.claim.sub = '75000000-0000-4000-8000-000000000101';
select ok(not public.can_read_supporting_document_employee('75000000-0000-4000-8000-000000000401'), '45) membresia revocada corta contenido');
select is((select count(*)::integer from public.supporting_documents_metadata), 0, '46) membresia revocada corta metadata');
reset role;
update public.company_memberships set active=true
where id='75000000-0000-4000-8000-000000000201';

-- La solicitud 61 se bloquea; no devuelve metadata y el contador se satura.
update public.workforce_data_access_limits
set request_count=60
where company_id='75000000-0000-4000-8000-000000000001'
  and actor_id='75000000-0000-4000-8000-000000000101'
  and scope='supporting_document.download';
set local role authenticated;
set local request.jwt.claim.sub = '75000000-0000-4000-8000-000000000101';
delete from test_document_rate;
insert into test_document_rate
select * from public.authorize_supporting_document_download('75000000-0000-4000-8000-000000000501');
select ok(not (select allowed from test_document_rate), '47) solicitud 61 queda bloqueada');
select ok(
  (select storage_path is null and original_filename is null and mime_type is null from test_document_rate),
  '48) 429 no filtra metadata'
);
select ok((select retry_after_seconds between 1 and 300 from test_document_rate), '49) Retry-After deriva de ventana real');
do $$
begin
  for i in 1..10 loop
    perform * from public.authorize_supporting_document_download('75000000-0000-4000-8000-000000000501');
  end loop;
end;
$$;
reset role;
select is(
  (select request_count from public.workforce_data_access_limits
   where company_id='75000000-0000-4000-8000-000000000001'
     and actor_id='75000000-0000-4000-8000-000000000101'
     and scope='supporting_document.download'),
  62, '50) trafico bloqueado se satura'
);
select is(
  (select count(*)::integer from public.audit_log
   where actor_id='75000000-0000-4000-8000-000000000101'
     and entity_id='75000000-0000-4000-8000-000000000501'
     and action='SUPPORTING_DOCUMENT_DOWNLOAD_RATE_LIMITED'),
  1, '51) bloqueo repetido no amplifica auditoria'
);

-- El mismo scope tiene un contador independiente en otro tenant/actor.
set local role authenticated;
set local request.jwt.claim.sub = '75000000-0000-4000-8000-000000000102';
select ok(
  (select allowed from public.authorize_supporting_document_download('75000000-0000-4000-8000-000000000502')),
  '52) RRHH dos descarga su propio tenant'
);
reset role;
select is(
  (select count(*)::integer from public.workforce_data_access_limits
   where scope='supporting_document.download'
     and company_id in ('75000000-0000-4000-8000-000000000001','75000000-0000-4000-8000-000000000002')),
  2, '53) cuota mantiene particiones empresa/actor separadas'
);

select * from finish();
rollback;
