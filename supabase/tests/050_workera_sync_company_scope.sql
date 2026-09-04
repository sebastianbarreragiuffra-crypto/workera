-- MT-3B recorte 2 (parte 2): aislamiento por empresa del pipeline de
-- sincronización Workera (sync_runs, workera_attendance_events) y del motor
-- de reglas (rule_engine_runs) -- antes de esta migración, los tres eran
-- locks/claves de idempotencia GLOBALES, así que dos empresas colisionaban
-- entre sí sin relación real.
create extension if not exists pgtap;
begin;
select plan(14);

-- Simula dentro de esta transacción el estado futuro en que MT-3A permita
-- encender un segundo workspace laboral. El constraint se restaura con el
-- ROLLBACK final; producción permanece fail-closed.
alter table public.companies drop constraint companies_workspace_mt3a_gate_chk;

insert into public.companies (id,name,legal_name,slug,active,status,workspace_enabled)
values ('cc000000-0000-0000-0000-000000000001','MT-3B Ajena 3','MT-3B Ajena 3 SpA','mt3b-ajena-3',true,'ACTIVE',true);

insert into public.profiles (id,display_name,role,active) values
 ('cc000000-0000-0000-0000-000000000101','Admin ARCOTEX','ADMIN_RRHH',true),
 ('cc000000-0000-0000-0000-000000000102','Admin Ajena',null,true);

insert into public.company_memberships (user_id,company_id,role,active)
values ('cc000000-0000-0000-0000-000000000102','cc000000-0000-0000-0000-000000000001','ADMIN_RRHH',true);

insert into public.company_membership_roles (company_id,membership_id,role_id)
select cm.company_id,cm.id,cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id=cm.company_id and cr.code='HR_ADMIN'
where cm.user_id='cc000000-0000-0000-0000-000000000102';

-- Un empleado ARCOTEX (company_id default) y un empleado de la empresa
-- ajena, con el MISMO código externo de Workera -- el escenario que antes
-- rompía employees_external_workera_id_key.
insert into public.employees (id,external_workera_id,first_name,last_name,display_name)
values ('cc000000-0000-0000-0000-000000000201','MT3B3-DUP-CODE','Empleado','Arcotex','Empleado Arcotex');

select lives_ok(
  $$ insert into public.employees (id,company_id,external_workera_id,first_name,last_name,display_name)
     values ('cc000000-0000-0000-0000-000000000202','cc000000-0000-0000-0000-000000000001','MT3B3-DUP-CODE','Empleado','Ajena','Empleado Ajena') $$,
  '1) mismo external_workera_id en empresas distintas ya no colisiona'
);

select throws_ok(
  $$ insert into public.employees (external_workera_id,first_name,last_name,display_name)
     values ('MT3B3-DUP-CODE','Otro','Arcotex','Otro Arcotex') $$,
  '23505', null,
  '2) mismo external_workera_id en la MISMA empresa sigue rechazado'
);

-- sync_runs: mismo rango de fechas, dos empresas -> ya no compiten por el
-- mismo lock.
insert into public.sync_runs (id,company_id,status,target_period_start,target_period_end)
values ('cc000000-0000-0000-0000-000000000301','0a4c0000-0000-0000-0000-000000000001','RUNNING','2026-09-02','2026-09-02');

select lives_ok(
  $$ insert into public.sync_runs (company_id,status,target_period_start,target_period_end)
     values ('cc000000-0000-0000-0000-000000000001','RUNNING','2026-09-02','2026-09-02') $$,
  '3) dos empresas pueden tener sync_runs RUNNING para el mismo rango'
);
select throws_ok(
  $$ insert into public.sync_runs (company_id,status,target_period_start,target_period_end)
     values ('0a4c0000-0000-0000-0000-000000000001','RUNNING','2026-09-02','2026-09-02') $$,
  '23505', null,
  '4) la MISMA empresa sigue sin poder correr dos sync_runs concurrentes'
);

-- rule_engine_runs: mismo work_date, dos empresas -> ya no compiten.
insert into public.rule_engine_runs (id,company_id,work_date,status,triggered_by)
values ('cc000000-0000-0000-0000-000000000401','0a4c0000-0000-0000-0000-000000000001','2026-09-02','RUNNING','MANUAL');

select lives_ok(
  $$ insert into public.rule_engine_runs (company_id,work_date,status,triggered_by)
     values ('cc000000-0000-0000-0000-000000000001','2026-09-02','RUNNING','MANUAL') $$,
  '5) dos empresas pueden procesar el motor de reglas el mismo work_date'
);
select throws_ok(
  $$ insert into public.rule_engine_runs (company_id,work_date,status,triggered_by)
     values ('0a4c0000-0000-0000-0000-000000000001','2026-09-02','RUNNING','MANUAL') $$,
  '23505', null,
  '6) la MISMA empresa sigue sin poder correr dos rule_engine_runs concurrentes'
);

-- workera_attendance_events: mismo external_employee_code/timestamp/tipo/
-- origin_code, dos empleados de empresas distintas -> ya no colisionan, y
-- company_id se resuelve solo desde employees, nunca del cliente.
insert into public.workera_attendance_events
  (id,employee_id,external_employee_code,attendance_timestamp_raw,attendance_type_code,attendance_type_label,attendance_status,external_attendance_status,origin_code,sync_run_id)
values
  ('cc000000-0000-0000-0000-000000000501','cc000000-0000-0000-0000-000000000201','DUP-CODE','2026-09-02T08:00:00',0,'ENTRADA','OK','OK','DEV1','cc000000-0000-0000-0000-000000000301');

select lives_ok(
  $$ insert into public.workera_attendance_events
       (employee_id,external_employee_code,attendance_timestamp_raw,attendance_type_code,attendance_type_label,attendance_status,external_attendance_status,origin_code,sync_run_id)
     values
       ('cc000000-0000-0000-0000-000000000202','DUP-CODE','2026-09-02T08:00:00',0,'ENTRADA','OK','OK','DEV1','cc000000-0000-0000-0000-000000000301') $$,
  '7) mismo fingerprint crudo en empresas distintas ya no colisiona'
);
select is(
  (select company_id from public.workera_attendance_events where employee_id='cc000000-0000-0000-0000-000000000202' and is_current),
  'cc000000-0000-0000-0000-000000000001',
  '8) company_id se resolvió solo desde employees.company_id, no de un valor de cliente'
);
select has_trigger(
  'public', 'workera_attendance_events', 'workera_attendance_events_immutable',
  '9) el backfill conserva el trigger de inmutabilidad de marcaciones'
);
select throws_ok(
  $$ update public.workera_attendance_events
     set company_id = 'cc000000-0000-0000-0000-000000000001'
     where id = 'cc000000-0000-0000-0000-000000000501' $$,
  'P0001', null,
  '10) company_id queda inmutable después del backfill controlado'
);

-- RLS: el admin ajeno no ve nada de las corridas/eventos de ARCOTEX.
set local role authenticated;
set local request.jwt.claim.sub='cc000000-0000-0000-0000-000000000102';
select is((select count(*)::int from public.sync_runs where id='cc000000-0000-0000-0000-000000000301'),0,'11) ajena no ve sync_runs de ARCOTEX');
select is((select count(*)::int from public.rule_engine_runs where id='cc000000-0000-0000-0000-000000000401'),0,'12) ajena no ve rule_engine_runs de ARCOTEX');
select is((select count(*)::int from public.workera_attendance_events where id='cc000000-0000-0000-0000-000000000501'),0,'13) ajena no ve workera_attendance_events de ARCOTEX');
select is((select count(*)::int from public.workera_attendance_events where employee_id='cc000000-0000-0000-0000-000000000202'),1,'14) ajena sí ve su propio evento');
reset role;

select * from finish();
rollback;
