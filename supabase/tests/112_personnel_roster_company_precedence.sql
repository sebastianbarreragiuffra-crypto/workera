-- pgTAP: frontera cerrada del roster Excel.
create extension if not exists pgtap;
begin;
select plan(11);
select has_function('public','apply_personnel_roster_import',array['uuid','jsonb','jsonb','jsonb','jsonb','uuid'],'firma con snapshot confirmado');
select ok((select prosecdef and provolatile='v' from pg_proc where oid='public.apply_personnel_roster_import(uuid,jsonb,jsonb,jsonb,jsonb,uuid)'::regprocedure),'RPC volatile/security definer');
select ok(not has_table_privilege('authenticated','public.employees','INSERT') and not has_table_privilege('authenticated','public.employees','UPDATE') and not has_table_privilege('authenticated','public.employees','DELETE'),'authenticated no salta el RPC');

alter table public.companies drop constraint companies_workspace_mt3a_gate_chk;
insert into public.companies(id,name,slug,active,status,workspace_enabled) values
 ('b1200000-0000-4000-8000-000000000001','ROSTER A','roster-a-112',true,'ACTIVE',true),
 ('b1200000-0000-4000-8000-000000000002','ROSTER B','roster-b-112',true,'ACTIVE',false);
insert into public.profiles(id,display_name,role,active) values('b1200000-0000-4000-8000-000000000101','ADMIN A','ADMIN_RRHH',true);
insert into public.company_memberships(id,user_id,company_id,role,active) values
 ('b1200000-0000-4000-8000-000000000111','b1200000-0000-4000-8000-000000000101','b1200000-0000-4000-8000-000000000001','ADMIN_RRHH',true),
 ('b1200000-0000-4000-8000-000000000112','b1200000-0000-4000-8000-000000000101','b1200000-0000-4000-8000-000000000002','ADMIN_RRHH',true);
insert into public.company_membership_roles(company_id,membership_id,role_id)
select cm.company_id,cm.id,cr.id from public.company_memberships cm join public.company_roles cr on cr.company_id=cm.company_id and cr.base_role=cm.role
where cm.id in('b1200000-0000-4000-8000-000000000111','b1200000-0000-4000-8000-000000000112');
insert into public.employees(id,company_id,external_workera_id,rut,first_name,last_name,display_name,source,active,created_at,updated_at) values
 ('b1200000-0000-4000-8000-000000000301','b1200000-0000-4000-8000-000000000001','EXCEL-71200002-2','71200002-2','ANA','UNO','ANA UNO','excel_roster',true,'2026-09-07 10:00+00','2026-09-07 10:00+00'),
 ('b1200000-0000-4000-8000-000000000302','b1200000-0000-4000-8000-000000000001','EXCEL-71200003-3','71200003-3','BETO','DOS','BETO DOS','excel_roster',true,'2026-09-07 10:00+00','2026-09-07 10:00+00'),
 ('b1200000-0000-4000-8000-000000000303','b1200000-0000-4000-8000-000000000001','WORKERA-4','71200004-4','CATA','TRES','CATA TRES','workera',false,'2026-09-07 10:00+00','2026-09-07 10:00+00');
insert into public.employee_birthdays(employee_id,birth_month,birth_day,created_by) values('b1200000-0000-4000-8000-000000000301',1,2,'b1200000-0000-4000-8000-000000000101');

set local role authenticated;
set local request.jwt.claim.sub='b1200000-0000-4000-8000-000000000101';
select throws_ok($$select public.apply_personnel_roster_import('b1200000-0000-4000-8000-000000000001','[]','[]','[]','[]','b1200000-0000-4000-8000-000000000101')$$,'22023',null,'snapshot vacío bloqueado');
select throws_ok($$select public.apply_personnel_roster_import('b1200000-0000-4000-8000-000000000002','["71200009-9"]','[]','[]','[]','b1200000-0000-4000-8000-000000000101')$$,'42501',null,'workspace deshabilitado bloqueado');
select throws_ok($$select public.apply_personnel_roster_import('b1200000-0000-4000-8000-000000000001','["71200002-2"]','[]','[]','[]','b1200000-0000-4000-8000-000000000101')$$,'22023',null,'plan parcial bloqueado');
select is(public.apply_personnel_roster_import(
 'b1200000-0000-4000-8000-000000000001','["71200002-2","71200005-5"]',
 '[{"rut":"71200005-5","first_name":"DANI","last_name":"CUATRO","display_name":"DANI CUATRO","employee_group_id":"","hire_date":""}]',
 '[{"id":"b1200000-0000-4000-8000-000000000301","employee_group_id":"","hire_date":"","birth_month":"3","birth_day":"4","prior_birth_month":"1","prior_birth_day":"2","prior_rut":"71200002-2","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]',
 '[{"id":"b1200000-0000-4000-8000-000000000302","prior_rut":"71200003-3","prior_source":"excel_roster","prior_active":true,"prior_updated_at":"2026-09-07T10:00:00+00:00"}]','b1200000-0000-4000-8000-000000000101'),
 '{"inserted_count":1,"updated_count":1,"reactivated_count":0,"deactivated_count":1}'::jsonb,'aplica snapshot completo');
reset role;
select ok(exists(select 1 from public.employees where rut='71200005-5' and active),'inserta confirmado');
select ok(not(select active from public.employees where id='b1200000-0000-4000-8000-000000000302'),'desactiva Excel ausente');
select ok(not(select active from public.employees where id='b1200000-0000-4000-8000-000000000303'),'Workera conserva estado');
select ok(exists(select 1 from public.employee_birthdays where employee_id='b1200000-0000-4000-8000-000000000301' and birth_month=3 and birth_day=4),'cumpleaños actualizado con CAS');
select * from finish();
rollback;
