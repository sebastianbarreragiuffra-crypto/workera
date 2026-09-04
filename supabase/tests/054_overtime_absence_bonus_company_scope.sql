-- MT-3B recorte 2 (parte 3): autorización por empresa sobre horas extra
-- (vía grupo), ausencias (directa + decisión referenciada), excepciones de
-- control horario y cumpleaños.
create extension if not exists pgtap;
begin;
select plan(10);

-- Simula dentro de esta transacción el estado futuro en que MT-3A permita
-- encender un segundo workspace laboral. El constraint se restaura con el
-- ROLLBACK final; producción permanece fail-closed.
alter table public.companies drop constraint companies_workspace_mt3a_gate_chk;

insert into public.companies (id,name,legal_name,slug,active,status,workspace_enabled)
values ('dd000000-0000-0000-0000-000000000001','MT-3B Ajena 4','MT-3B Ajena 4 SpA','mt3b-ajena-4',true,'ACTIVE',true);

insert into public.profiles (id,display_name,role,active) values
 ('dd000000-0000-0000-0000-000000000101','Admin ARCOTEX','ADMIN_RRHH',true),
 ('dd000000-0000-0000-0000-000000000102','Admin Ajena',null,true);

insert into public.company_memberships (user_id,company_id,role,active)
values ('dd000000-0000-0000-0000-000000000102','dd000000-0000-0000-0000-000000000001','ADMIN_RRHH',true);

insert into public.company_membership_roles (company_id,membership_id,role_id)
select cm.company_id,cm.id,cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id=cm.company_id and cr.code='HR_ADMIN'
where cm.user_id='dd000000-0000-0000-0000-000000000102';

-- Grupo y política de horas extra de la empresa ajena.
insert into public.employee_groups (id,company_id,code,name)
values ('dd000000-0000-0000-0000-000000000201','dd000000-0000-0000-0000-000000000001','MT3B4_GROUP','Grupo MT3B4');
insert into public.overtime_policies (id,employee_group_id,day_of_week,overtime_eligible,max_overtime_minutes,effective_from)
values ('dd000000-0000-0000-0000-000000000301','dd000000-0000-0000-0000-000000000201',1,true,120,current_date);

-- Empleado, ausencia y decisión de ausencia, política de control horario y
-- cumpleaños, todos de ARCOTEX (company_id default).
insert into public.employees (id,external_workera_id,first_name,last_name,display_name)
values ('dd000000-0000-0000-0000-000000000401','MT3B4-ARCOTEX-001','Empleado','Arcotex','Empleado Arcotex');

insert into public.absence_records (id,employee_id,absence_type_id,start_date,end_date,source,source_hash,created_by)
values ('dd000000-0000-0000-0000-000000000501','dd000000-0000-0000-0000-000000000401',
        (select id from public.absence_types where code='VACATION'),
        current_date, current_date + 5, 'manual', 'mt3b4-abs-hash-1','dd000000-0000-0000-0000-000000000101');

insert into public.absence_decisions (id,absence_record_id,decision_status,decided_by)
values ('dd000000-0000-0000-0000-000000000601','dd000000-0000-0000-0000-000000000501','CONFIRMED','dd000000-0000-0000-0000-000000000101');

insert into public.employee_time_control_policies (id,employee_id,policy_code,effective_from,created_by)
values ('dd000000-0000-0000-0000-000000000701','dd000000-0000-0000-0000-000000000401','NORMAL',current_date,'dd000000-0000-0000-0000-000000000101');

insert into public.employee_birthdays (id,employee_id,birth_month,birth_day)
values ('dd000000-0000-0000-0000-000000000801','dd000000-0000-0000-0000-000000000401',5,20);

-- Helper nuevo: comportamiento directo.
select ok(public.employee_group_belongs_to_active_company('dd000000-0000-0000-0000-000000000201') = false,
  '1) helper rechaza grupo ajeno para un usuario sin membresía ahí');

set local role authenticated;
set local request.jwt.claim.sub='dd000000-0000-0000-0000-000000000102';
select ok(public.employee_group_belongs_to_active_company('dd000000-0000-0000-0000-000000000201'),
  '2) helper permite grupo propio al admin ajeno');
select is((select count(*)::int from public.overtime_policies where id='dd000000-0000-0000-0000-000000000301'),1,
  '3) admin ajeno ve su propia overtime_policy');
reset role;

-- Admin ARCOTEX ve todo lo suyo.
set local role authenticated;
set local request.jwt.claim.sub='dd000000-0000-0000-0000-000000000101';
select is((select count(*)::int from public.absence_records where id='dd000000-0000-0000-0000-000000000501'),1,'4) admin ARCOTEX ve absence_records');
select is((select count(*)::int from public.absence_decisions where id='dd000000-0000-0000-0000-000000000601'),1,'5) admin ARCOTEX ve absence_decisions');
select is((select count(*)::int from public.employee_time_control_policies where id='dd000000-0000-0000-0000-000000000701'),1,'6) admin ARCOTEX ve employee_time_control_policies');
select is((select count(*)::int from public.employee_birthdays where id='dd000000-0000-0000-0000-000000000801'),1,'7) admin ARCOTEX ve employee_birthdays');
reset role;

-- Admin ajeno no ve nada de ARCOTEX ni puede resolver la política del grupo ARCOTEX.
set local role authenticated;
set local request.jwt.claim.sub='dd000000-0000-0000-0000-000000000102';
select is((select count(*)::int from public.absence_records where id='dd000000-0000-0000-0000-000000000501'),0,'8) ajena no ve absence_records de ARCOTEX');
select is((select count(*)::int from public.absence_decisions where id='dd000000-0000-0000-0000-000000000601'),0,'9) ajena no ve absence_decisions de ARCOTEX (join vía absence_records)');
select is((select count(*)::int from public.employee_time_control_policies where id='dd000000-0000-0000-0000-000000000701'),0,'10) ajena no ve employee_time_control_policies de ARCOTEX');
reset role;

select * from finish();
rollback;
