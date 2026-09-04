-- MT-3B recorte 2 (parte 1): autorización por empresa sobre el núcleo de
-- asistencia (attendance_records, attendance_corrections,
-- attendance_status_records, attendance_missing_punch_flags).
create extension if not exists pgtap;
begin;
select plan(13);

insert into public.companies (id,name,legal_name,slug,active,status,workspace_enabled)
values ('bb000000-0000-0000-0000-000000000001','MT-3B Ajena 2','MT-3B Ajena 2 SpA','mt3b-ajena-2',true,'ONBOARDING',false);

insert into public.profiles (id,display_name,role,active) values
 ('bb000000-0000-0000-0000-000000000101','Admin ARCOTEX','ADMIN_RRHH',true),
 ('bb000000-0000-0000-0000-000000000102','Admin Ajena',null,true);

insert into public.company_memberships (user_id,company_id,role,active)
values ('bb000000-0000-0000-0000-000000000102','bb000000-0000-0000-0000-000000000001','ADMIN_RRHH',true);

-- Empleado ARCOTEX (compañía por defecto de employees.company_id) y su
-- asistencia cruda + corrección + código diario + flag de marcación
-- incompleta.
insert into public.employees (id,external_workera_id,first_name,last_name,display_name)
values ('bb000000-0000-0000-0000-000000000201','MT3B2-ARCOTEX-001','Empleado','Arcotex','Empleado Arcotex');

insert into public.attendance_records (id,employee_id,work_date,actual_clock_in,actual_clock_out,source,source_hash)
values ('bb000000-0000-0000-0000-000000000301','bb000000-0000-0000-0000-000000000201',current_date,
        current_date + time '08:00', current_date + time '17:00','manual','mt3b2-hash-1');

insert into public.attendance_corrections (id,attendance_record_id,employee_id,work_date,corrected_clock_out,reason,corrected_by)
values ('bb000000-0000-0000-0000-000000000401','bb000000-0000-0000-0000-000000000301','bb000000-0000-0000-0000-000000000201',
        current_date, current_date + time '17:30', 'Ajuste de prueba MT-3B','bb000000-0000-0000-0000-000000000101');

insert into public.attendance_status_records (id,employee_id,work_date,attendance_status_id,source,source_hash,created_by)
values ('bb000000-0000-0000-0000-000000000501','bb000000-0000-0000-0000-000000000201',current_date,
        (select id from public.attendance_statuses where code='P'),'manual','mt3b2-status-hash-1','bb000000-0000-0000-0000-000000000101');

insert into public.attendance_missing_punch_flags (id,attendance_record_id,employee_id,work_date,missing_type)
values ('bb000000-0000-0000-0000-000000000601','bb000000-0000-0000-0000-000000000301','bb000000-0000-0000-0000-000000000201',
        current_date,'MISSING_CLOCK_IN');

-- Admin ARCOTEX ve todo lo que acaba de crearse.
set local role authenticated;
set local request.jwt.claim.sub='bb000000-0000-0000-0000-000000000101';
select is((select count(*)::int from public.attendance_records where id='bb000000-0000-0000-0000-000000000301'),1,'admin ARCOTEX ve attendance_records');
select is((select count(*)::int from public.attendance_corrections where id='bb000000-0000-0000-0000-000000000401'),1,'admin ARCOTEX ve attendance_corrections');
select is((select count(*)::int from public.attendance_status_records where id='bb000000-0000-0000-0000-000000000501'),1,'admin ARCOTEX ve attendance_status_records');
select is((select count(*)::int from public.attendance_missing_punch_flags where id='bb000000-0000-0000-0000-000000000601'),1,'admin ARCOTEX ve attendance_missing_punch_flags');
select lives_ok($$update public.attendance_corrections set is_current=false where id='bb000000-0000-0000-0000-000000000401'$$,'admin ARCOTEX puede actualizar corrección propia');
select lives_ok($$update public.attendance_missing_punch_flags set status='CONTACTED' where id='bb000000-0000-0000-0000-000000000601'$$,'admin ARCOTEX puede actualizar flag propia');
reset role;

-- Restaurar estado para las siguientes aserciones cruzadas.
update public.attendance_corrections set is_current=true where id='bb000000-0000-0000-0000-000000000401';
update public.attendance_missing_punch_flags set status='PENDING_CONTACT' where id='bb000000-0000-0000-0000-000000000601';

-- Admin de la empresa ajena no ve ni puede tocar nada de ARCOTEX.
set local role authenticated;
set local request.jwt.claim.sub='bb000000-0000-0000-0000-000000000102';
select is((select count(*)::int from public.attendance_records where id='bb000000-0000-0000-0000-000000000301'),0,'ajena no ve attendance_records');
select is((select count(*)::int from public.attendance_corrections where id='bb000000-0000-0000-0000-000000000401'),0,'ajena no ve attendance_corrections');
select is((select count(*)::int from public.attendance_status_records where id='bb000000-0000-0000-0000-000000000501'),0,'ajena no ve attendance_status_records');
select is((select count(*)::int from public.attendance_missing_punch_flags where id='bb000000-0000-0000-0000-000000000601'),0,'ajena no ve attendance_missing_punch_flags');
select lives_ok($$update public.attendance_corrections set is_current=false where id='bb000000-0000-0000-0000-000000000401'$$,'UPDATE ajeno se filtra por RLS (no error, no filas)');
select lives_ok($$update public.attendance_missing_punch_flags set status='CONTACTED' where id='bb000000-0000-0000-0000-000000000601'$$,'UPDATE ajeno se filtra por RLS (no error, no filas)');
reset role;

select is((select is_current from public.attendance_corrections where id='bb000000-0000-0000-0000-000000000401'),true,'UPDATE ajeno no modificó la corrección');

select * from finish();
rollback;
