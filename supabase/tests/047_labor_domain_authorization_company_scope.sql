-- MT-3B recorte 1: autorización por empresa sobre raíces laborales operativas.
-- La empresa ajena permanece en onboarding por el gate MT-3A.
create extension if not exists pgtap;
begin;
select plan(20);
select has_function('public', 'employee_belongs_to_active_company', array['uuid'], 'existe helper de aislamiento');
select has_trigger('public', 'profiles', 'profiles_sync_arcotex_membership', 'existe trigger de sincronización');
insert into public.companies (id,name,legal_name,slug,active,status,workspace_enabled)
values ('aa000000-0000-0000-0000-000000000001','MT-3B Ajena','MT-3B Ajena SpA','mt3b-ajena',true,'ONBOARDING',false);
insert into public.profiles (id,display_name,role,active) values
 ('aa000000-0000-0000-0000-000000000101','Admin ARCOTEX','ADMIN_RRHH',true),
 ('aa000000-0000-0000-0000-000000000102','Admin Ajena',null,true);
insert into public.company_memberships (user_id,company_id,role,active)
values ('aa000000-0000-0000-0000-000000000102','aa000000-0000-0000-0000-000000000001','ADMIN_RRHH',true);
select ok(exists(select 1 from public.company_memberships where user_id='aa000000-0000-0000-0000-000000000101' and company_id=(select id from public.companies where slug='arcotex') and active),'profile ARCOTEX sincroniza membresía');
update public.profiles set role='SUPERVISOR_INSTALLATION' where id='aa000000-0000-0000-0000-000000000101';
select ok(exists(select 1 from public.company_memberships where user_id='aa000000-0000-0000-0000-000000000101' and role='SUPERVISOR_INSTALLATION' and active),'cambio de rol sincroniza membresía');
update public.profiles set role=null where id='aa000000-0000-0000-0000-000000000101';
select ok(not exists(select 1 from public.company_memberships where user_id='aa000000-0000-0000-0000-000000000101' and company_id=(select id from public.companies where slug='arcotex') and active),'rol nulo desactiva membresía');
update public.profiles set role='ADMIN_RRHH' where id='aa000000-0000-0000-0000-000000000101';
insert into public.employees (id,external_workera_id,first_name,last_name,display_name)
values ('aa000000-0000-0000-0000-000000000201','MT3B-ARCOTEX-001','Empleado','Arcotex','Empleado Arcotex');
insert into public.employee_groups (id,code,name) values ('aa000000-0000-0000-0000-000000000301','MT3B_GROUP','Grupo MT3B');
insert into public.supervisor_assignments (id,employee_id,supervisor_profile_id,effective_from)
values ('aa000000-0000-0000-0000-000000000401','aa000000-0000-0000-0000-000000000201','aa000000-0000-0000-0000-000000000101',current_date);
set local role authenticated;
set local request.jwt.claim.sub='aa000000-0000-0000-0000-000000000101';
select is((select count(*)::int from public.employees where id='aa000000-0000-0000-0000-000000000201'),1,'admin ARCOTEX ve empleado');
select ok(public.employee_belongs_to_active_company('aa000000-0000-0000-0000-000000000201'),'helper permite miembro ARCOTEX');
select ok(public.can_manage_employee('aa000000-0000-0000-0000-000000000201'),'admin ARCOTEX puede gestionar');
select is((select count(*)::int from public.employee_groups where id='aa000000-0000-0000-0000-000000000301'),1,'admin ARCOTEX ve grupos');
select is((select count(*)::int from public.supervisor_assignments where id='aa000000-0000-0000-0000-000000000401'),1,'admin ARCOTEX ve asignaciones');
reset role;
set local role authenticated;
set local request.jwt.claim.sub='aa000000-0000-0000-0000-000000000102';
select is((select count(*)::int from public.employees where id='aa000000-0000-0000-0000-000000000201'),0,'usuario ajeno no ve empleado');
select ok(not public.employee_belongs_to_active_company('aa000000-0000-0000-0000-000000000201'),'helper rechaza empresa ajena');
select ok(not public.can_manage_employee('aa000000-0000-0000-0000-000000000201'),'usuario ajeno no gestiona');
select is((select count(*)::int from public.employee_groups where id='aa000000-0000-0000-0000-000000000301'),0,'usuario ajeno no ve grupos');
select is((select count(*)::int from public.supervisor_assignments where id='aa000000-0000-0000-0000-000000000401'),0,'usuario ajeno no ve asignaciones');
select is((select count(*)::int from public.company_memberships where user_id='aa000000-0000-0000-0000-000000000102'),1,'usuario ajeno solo conserva su membresía');
select lives_ok($$update public.employees set display_name='Hackeado' where id='aa000000-0000-0000-0000-000000000201'$$,'UPDATE ajeno se filtra por RLS');
reset role;
select is((select display_name from public.employees where id='aa000000-0000-0000-0000-000000000201'),'Empleado Arcotex','UPDATE ajeno no modifica fila');
select ok(not exists(select 1 from public.company_memberships where user_id='aa000000-0000-0000-0000-000000000102' and company_id=(select id from public.companies where slug='arcotex')),'empresa ajena no crea reflejo ARCOTEX');
select ok(not (select workspace_enabled from public.companies where slug='mt3b-ajena'),'empresa ajena sigue bloqueada por MT-3A');
select * from finish();
rollback;
