-- P0-A: salud observable del sweeper sin exponer rutas ni PII.
create extension if not exists pgtap;

begin;
select plan(19);

select has_function(
  'public', 'get_supporting_document_cleanup_health', array['integer'],
  'existe snapshot de salud'
);
select ok(
  not has_function_privilege('authenticated', 'public.get_supporting_document_cleanup_health(integer)', 'EXECUTE'),
  'el navegador no consulta el backlog global'
);
select ok(
  has_function_privilege('service_role', 'public.get_supporting_document_cleanup_health(integer)', 'EXECUTE'),
  'el watchdog privilegiado consulta salud'
);
select is((
  select p.proconfig[1]
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='get_supporting_document_cleanup_health'
), 'search_path=""', 'la funcion fija search_path vacio');

insert into public.profiles (id, display_name, role, active)
values ('80000000-0000-0000-0000-000000000001', 'Actor health', 'ADMIN_RRHH', true);
insert into public.employees (
  id, external_workera_id, first_name, last_name, display_name, employee_group_id
) values (
  '80000000-0000-0000-0000-000000000101', 'HEALTH-EMP', 'Test', 'Health', 'Test Health',
  (select id from public.employee_groups where code='ADMINISTRATION')
);
insert into public.supporting_document_upload_intents (
  id, actor_id, employee_id, storage_path, mime_type, file_size, created_at,
  expires_at, consumed_at, cleanup_attempt, cleanup_locked_at,
  cleanup_locked_by, cleanup_completed_at, cleanup_result, cleanup_error_code
) values
  ('80000000-0000-0000-0000-000000000201','80000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000101','health/pending.pdf','application/pdf',100,now()-interval '30 minutes',now()-interval '20 minutes',null,0,null,null,null,null,null),
  ('80000000-0000-0000-0000-000000000202','80000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000101','health/stale.pdf','application/pdf',100,now()-interval '3 hours',now()-interval '2 hours',null,0,null,null,null,null,null),
  ('80000000-0000-0000-0000-000000000203','80000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000101','health/locked.pdf','application/pdf',100,now()-interval '3 hours',now()-interval '2 hours',null,1,now(), '80000000-0000-0000-0000-000000000901',null,null,null),
  ('80000000-0000-0000-0000-000000000204','80000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000101','health/failed.pdf','application/pdf',100,now()-interval '3 hours',now()-interval '2 hours',null,3,null,null,now(),'FAILED','STORAGE_DENIED'),
  ('80000000-0000-0000-0000-000000000205','80000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000101','health/fresh.pdf','application/pdf',100,now(),now()+interval '10 minutes',null,0,null,null,null,null,null),
  ('80000000-0000-0000-0000-000000000206','80000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000101','health/consumed.pdf','application/pdf',100,now()-interval '3 hours',now()-interval '2 hours',now()-interval '1 hour',0,null,null,null,null,null),
  ('80000000-0000-0000-0000-000000000207','80000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000101','health/protected.pdf','application/pdf',100,now()-interval '3 hours',now()-interval '2 hours',null,0,null,null,null,null,null);
insert into public.supporting_documents (
  id, employee_id, document_type, storage_path, mime_type, original_filename, uploaded_by
) values (
  '80000000-0000-0000-0000-000000000301','80000000-0000-0000-0000-000000000101',
  'OTHER','health/protected.pdf','application/pdf','protected.pdf',
  '80000000-0000-0000-0000-000000000001'
);

set local role service_role;
select throws_ok(
  $$select * from public.get_supporting_document_cleanup_health(3599)$$,
  '22023', 'Umbral de salud de documentos invalido.',
  'umbral demasiado corto se rechaza'
);
select throws_ok(
  $$select * from public.get_supporting_document_cleanup_health(604801)$$,
  '22023', 'Umbral de salud de documentos invalido.',
  'umbral demasiado largo se rechaza'
);
create temporary table unhealthy_snapshot as
select * from public.get_supporting_document_cleanup_health(3600);
select is((select count(*)::integer from unhealthy_snapshot), 1, 'snapshot siempre entrega una fila agregada');
select is((select pending_ready_count from unhealthy_snapshot), 2::bigint, 'cuenta backlog listo sin vigentes ni protegidos');
select is((select locked_count from unhealthy_snapshot), 1::bigint, 'cuenta leases activas');
select is((select failed_count from unhealthy_snapshot), 1::bigint, 'cuenta fallos terminales');
select is((select stale_pending_count from unhealthy_snapshot), 1::bigint, 'detecta backlog sobre umbral');
select ok((select oldest_pending_expires_at is not null from unhealthy_snapshot), 'expone antiguedad sin ruta');
select ok((select requires_attention from unhealthy_snapshot), 'fallo o backlog antiguo exige alerta');
reset role;

update public.supporting_document_upload_intents
set consumed_at=now(), cleanup_locked_at=null, cleanup_locked_by=null
where id between '80000000-0000-0000-0000-000000000201' and '80000000-0000-0000-0000-000000000204';
set local role service_role;
create temporary table healthy_snapshot as
select * from public.get_supporting_document_cleanup_health(3600);
select is((select pending_ready_count from healthy_snapshot), 0::bigint, 'sin huerfanos no hay backlog listo');
select is((select locked_count from healthy_snapshot), 0::bigint, 'sin huerfanos no hay leases');
select is((select failed_count from healthy_snapshot), 0::bigint, 'fallos consumidos dejan de ser accionables');
select is((select stale_pending_count from healthy_snapshot), 0::bigint, 'sin huerfanos no hay backlog viejo');
select is((select oldest_pending_expires_at from healthy_snapshot), null::timestamptz, 'sin backlog no se filtra timestamp');
select ok(not (select requires_attention from healthy_snapshot), 'snapshot limpio no alerta');
reset role;

select * from finish();
rollback;
