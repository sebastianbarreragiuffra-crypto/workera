-- MT-3B: la bitácora técnica de Workera/motor de reglas queda restringida
-- a COMPANY_OWNER y HR_ADMIN. attendance.read sigue permitiendo ver las
-- marcaciones operativas sin exponer reintentos ni error_summary.
create extension if not exists pgtap;
begin;
select plan(13);

alter table public.companies drop constraint companies_workspace_mt3a_gate_chk;

insert into public.companies (id,name,legal_name,slug,active,status,workspace_enabled)
values ('ef000000-0000-0000-0000-000000000001','MT-3B Permisos','MT-3B Permisos SpA','mt3b-permisos',true,'ACTIVE',true);

insert into public.profiles (id,display_name,role,active) values
 ('ef000000-0000-0000-0000-000000000101','RRHH tenant',null,true),
 ('ef000000-0000-0000-0000-000000000102','Supervisor tenant',null,true),
 ('ef000000-0000-0000-0000-000000000103','Auditor tenant',null,true);

insert into public.company_memberships (user_id,company_id,role,active) values
 ('ef000000-0000-0000-0000-000000000101','ef000000-0000-0000-0000-000000000001','ADMIN_RRHH',true),
 ('ef000000-0000-0000-0000-000000000102','ef000000-0000-0000-0000-000000000001','SUPERVISOR_PRODUCTION',true),
 ('ef000000-0000-0000-0000-000000000103','ef000000-0000-0000-0000-000000000001','ADMIN_RRHH',true);

insert into public.company_membership_roles (company_id,membership_id,role_id)
select cm.company_id,cm.id,cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id=cm.company_id
where (cm.user_id='ef000000-0000-0000-0000-000000000101' and cr.code='HR_ADMIN')
   or (cm.user_id='ef000000-0000-0000-0000-000000000102' and cr.code='PRODUCTION_SUPERVISOR')
   or (cm.user_id='ef000000-0000-0000-0000-000000000103' and cr.code='AUDITOR');

insert into public.employees (id,company_id,external_workera_id,first_name,last_name,display_name)
values ('ef000000-0000-0000-0000-000000000201','ef000000-0000-0000-0000-000000000001','MT3B-PERM-001','Persona','Tenant','Persona Tenant');

insert into public.sync_runs (id,company_id,status,target_period_start,target_period_end,error_summary)
values ('ef000000-0000-0000-0000-000000000301','ef000000-0000-0000-0000-000000000001','FAILED','2026-09-03','2026-09-03','{"message":"detalle técnico"}'::jsonb);

insert into public.rule_engine_runs (id,company_id,work_date,status,triggered_by,error_summary,finished_at)
values ('ef000000-0000-0000-0000-000000000401','ef000000-0000-0000-0000-000000000001','2026-09-03','FAILED','MANUAL','detalle técnico',clock_timestamp());

insert into public.workera_attendance_events
  (id,employee_id,external_employee_code,attendance_timestamp_raw,attendance_type_code,attendance_type_label,attendance_status,external_attendance_status,origin_code,sync_run_id)
values
  ('ef000000-0000-0000-0000-000000000501','ef000000-0000-0000-0000-000000000201','MT3B-PERM-001','2026-09-03T08:00:00',0,'ENTRADA','OK','OK','DEV1','ef000000-0000-0000-0000-000000000301');

select ok(exists(select 1 from public.permission_definitions where code='attendance.sync.read' and module_key='attendance'),
  '1) el permiso técnico pertenece al módulo attendance');
select ok(exists(select 1 from public.company_role_permissions crp join public.company_roles cr on cr.id=crp.role_id and cr.company_id=crp.company_id where cr.company_id='ef000000-0000-0000-0000-000000000001' and cr.code='COMPANY_OWNER' and crp.permission_code='attendance.sync.read'),
  '2) COMPANY_OWNER recibe attendance.sync.read');
select ok(exists(select 1 from public.company_role_permissions crp join public.company_roles cr on cr.id=crp.role_id and cr.company_id=crp.company_id where cr.company_id='ef000000-0000-0000-0000-000000000001' and cr.code='HR_ADMIN' and crp.permission_code='attendance.sync.read'),
  '3) HR_ADMIN recibe attendance.sync.read');
select ok(not exists(select 1 from public.company_role_permissions crp join public.company_roles cr on cr.id=crp.role_id and cr.company_id=crp.company_id where cr.company_id='ef000000-0000-0000-0000-000000000001' and cr.code='PRODUCTION_SUPERVISOR' and crp.permission_code='attendance.sync.read'),
  '4) supervisor no recibe attendance.sync.read');
select ok(not exists(select 1 from public.company_role_permissions crp join public.company_roles cr on cr.id=crp.role_id and cr.company_id=crp.company_id where cr.company_id='ef000000-0000-0000-0000-000000000001' and cr.code='AUDITOR' and crp.permission_code='attendance.sync.read'),
  '5) auditor no recibe attendance.sync.read');

set local role authenticated;
set local request.jwt.claim.sub='ef000000-0000-0000-0000-000000000101';
select is((select count(*)::int from public.sync_runs where id='ef000000-0000-0000-0000-000000000301'),1,'6) HR_ADMIN ve sync_runs propios');
select is((select count(*)::int from public.rule_engine_runs where id='ef000000-0000-0000-0000-000000000401'),1,'7) HR_ADMIN ve rule_engine_runs propios');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='ef000000-0000-0000-0000-000000000102';
select is((select count(*)::int from public.sync_runs where id='ef000000-0000-0000-0000-000000000301'),0,'8) supervisor no ve sync_runs');
select is((select count(*)::int from public.rule_engine_runs where id='ef000000-0000-0000-0000-000000000401'),0,'9) supervisor no ve rule_engine_runs');
select is((select count(*)::int from public.workera_attendance_events where id='ef000000-0000-0000-0000-000000000501'),1,'10) supervisor conserva lectura de marcaciones');
reset role;

set local role authenticated;
set local request.jwt.claim.sub='ef000000-0000-0000-0000-000000000103';
select is((select count(*)::int from public.sync_runs where id='ef000000-0000-0000-0000-000000000301'),0,'11) auditor no ve sync_runs');
select is((select count(*)::int from public.rule_engine_runs where id='ef000000-0000-0000-0000-000000000401'),0,'12) auditor no ve rule_engine_runs');
select is((select count(*)::int from public.workera_attendance_events where id='ef000000-0000-0000-0000-000000000501'),1,'13) auditor conserva lectura de marcaciones');
reset role;

select * from finish();
rollback;
