-- pgTAP: aprobar una licencia actualiza asistencia y cierra la ausencia en
-- una sola operación. Evita que Licencias diga APPROVED mientras la cola
-- diaria siga mostrando el mismo caso como pendiente.
create extension if not exists pgtap;

begin;
select plan(19);

select has_trigger(
  'public', 'medical_license_approvals',
  'medical_license_approval_closes_absence',
  'la aprobación médica tiene el cierre automático de ausencia'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'private.close_absence_after_medical_license_approval()',
    'EXECUTE'
  ),
  'el helper del trigger no se puede invocar directamente desde la API'
);

-- Los triggers de compatibilidad legacy crean para este ADMIN_RRHH la
-- membresía ARCOTEX y su permiso licenses.approve. El RPC exige además aal2.
insert into public.profiles (
  id, display_name, role, active, medical_license_approver
) values
  (
    'a7000000-0000-4000-8000-000000000101',
    'Supervisor Licencias 107', 'SUPERVISOR_PRODUCTION', true, false
  ),
  (
    'a7000000-0000-4000-8000-000000000102',
    'Aprobador Licencias 107', 'ADMIN_RRHH', true, true
  );

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id
) values (
  'a7000000-0000-4000-8000-000000000201',
  '0a4c0000-0000-0000-0000-000000000001',
  'TEST-ML-CLOSE-107', 'Licencia', 'Cierre', 'Licencia Cierre',
  (
    select eg.id from public.employee_groups eg
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and eg.code = 'PRODUCTION'
  )
);

insert into public.absence_records (
  id, employee_id, absence_type_id, start_date, end_date, source,
  source_hash, created_by
) values (
  'a7000000-0000-4000-8000-000000000301',
  'a7000000-0000-4000-8000-000000000201',
  (select at.id from public.absence_types at where at.code = 'MEDICAL_LEAVE'),
  date '2099-09-10', date '2099-09-12', 'manual',
  'test-medical-close-107-1',
  'a7000000-0000-4000-8000-000000000101'
);

insert into public.supporting_documents (
  id, employee_id, absence_record_id, document_type, storage_path, mime_type,
  original_filename, uploaded_by
) values (
  'a7000000-0000-4000-8000-000000000401',
  'a7000000-0000-4000-8000-000000000201',
  'a7000000-0000-4000-8000-000000000301',
  'MEDICAL_CERTIFICATE', 'test-only/license-close-107.pdf',
  'application/pdf', 'license-close-107.pdf',
  'a7000000-0000-4000-8000-000000000101'
);

insert into public.medical_license_approvals (
  id, absence_record_id, supporting_document_id, proposed_start_date,
  proposed_end_date, extraction_status, uploaded_by
) values (
  'a7000000-0000-4000-8000-000000000501',
  'a7000000-0000-4000-8000-000000000301',
  'a7000000-0000-4000-8000-000000000401',
  date '2099-09-10', date '2099-09-12', 'EXTRAIDO',
  'a7000000-0000-4000-8000-000000000101'
);

-- Simula que el supervisor alcanzó a marcar el caso como pendiente de
-- documento antes de que RRHH terminara la aprobación central.
insert into public.absence_decisions (
  id, absence_record_id, decision_status, document_required,
  document_deadline, reason, decided_by
) values (
  'a7000000-0000-4000-8000-000000000601',
  'a7000000-0000-4000-8000-000000000301',
  'PENDING_DOCUMENT', true, date '2099-09-15',
  'Pendiente antes de aprobación RRHH',
  'a7000000-0000-4000-8000-000000000101'
);

-- Un estado anterior prueba que L se versiona y queda como único vigente.
insert into public.attendance_status_records (
  id, employee_id, work_date, attendance_status_id, source, source_hash,
  source_version, created_by, reason
) values (
  'a7000000-0000-4000-8000-000000000701',
  'a7000000-0000-4000-8000-000000000201', date '2099-09-10',
  (select ats.id from public.attendance_statuses ats where ats.code = 'P'),
  'manual', 'test-medical-close-107-status', 1,
  'a7000000-0000-4000-8000-000000000101', 'Estado anterior'
);

set local role authenticated;
set local request.jwt.claim.sub = 'a7000000-0000-4000-8000-000000000102';
set local request.jwt.claim.aal = 'aal2';

select lives_ok(
  $$ select public.approve_medical_license(
       'a7000000-0000-4000-8000-000000000501',
       date '2099-09-10', date '2099-09-12'
     ) $$,
  'aprobar completa la licencia, la asistencia y la ausencia atómicamente'
);

reset role;

select is(
  (
    select mla.status::text
    from public.medical_license_approvals mla
    where mla.id = 'a7000000-0000-4000-8000-000000000501'
  ),
  'APPROVED',
  'la licencia queda APPROVED'
);

select is(
  (
    select count(*)::integer
    from public.attendance_status_records asr
    join public.attendance_statuses ats on ats.id = asr.attendance_status_id
    where asr.employee_id = 'a7000000-0000-4000-8000-000000000201'
      and asr.work_date between date '2099-09-10' and date '2099-09-12'
      and asr.is_current
      and ats.code = 'L'
  ),
  3,
  'cada día confirmado queda con L vigente'
);

select is(
  (
    select asr.is_current
    from public.attendance_status_records asr
    where asr.id = 'a7000000-0000-4000-8000-000000000701'
  ),
  false,
  'el estado diario anterior se conserva como versión histórica'
);

select is(
  (
    select count(*)::integer
    from public.absence_decisions ad
    where ad.absence_record_id = 'a7000000-0000-4000-8000-000000000301'
      and ad.is_current
  ),
  1,
  'queda exactamente una decisión de ausencia vigente'
);

select is(
  (
    select ad.decision_status
    from public.absence_decisions ad
    where ad.absence_record_id = 'a7000000-0000-4000-8000-000000000301'
      and ad.is_current
  ),
  'CONFIRMED',
  'la decisión vigente cierra la ausencia como CONFIRMED'
);

select is(
  (
    select ad.is_current
    from public.absence_decisions ad
    where ad.id = 'a7000000-0000-4000-8000-000000000601'
  ),
  false,
  'la decisión pendiente anterior queda en el historial'
);

select is(
  (
    select ad.decided_by
    from public.absence_decisions ad
    where ad.absence_record_id = 'a7000000-0000-4000-8000-000000000301'
      and ad.is_current
  ),
  'a7000000-0000-4000-8000-000000000102'::uuid,
  'la ausencia queda atribuida al aprobador real'
);

select is(
  (
    select ad.decided_at
    from public.absence_decisions ad
    where ad.absence_record_id = 'a7000000-0000-4000-8000-000000000301'
      and ad.is_current
  ),
  (
    select mla.approved_at
    from public.medical_license_approvals mla
    where mla.id = 'a7000000-0000-4000-8000-000000000501'
  ),
  'la aprobación y el cierre comparten el mismo instante auditable'
);

select is(
  (
    select ad.reason
    from public.absence_decisions ad
    where ad.absence_record_id = 'a7000000-0000-4000-8000-000000000301'
      and ad.is_current
  ),
  'Licencia médica aprobada por RRHH',
  'la decisión explica por qué se cerró automáticamente'
);

select is(
  (
    select count(*)::integer
    from public.absence_decisions ad
    where ad.absence_record_id = 'a7000000-0000-4000-8000-000000000301'
      and ad.is_current
      and ad.decision_status in ('PENDING_DOCUMENT', 'DISPUTED')
  ),
  0,
  'el caso aprobado ya no conserva un estado pendiente en la cola diaria'
);

set local role authenticated;
set local request.jwt.claim.sub = 'a7000000-0000-4000-8000-000000000102';
set local request.jwt.claim.aal = 'aal2';

select throws_ok(
  $$ select public.approve_medical_license(
       'a7000000-0000-4000-8000-000000000501',
       date '2099-09-10', date '2099-09-12'
     ) $$,
  'P0001',
  'La licencia no existe o ya no está pendiente de aprobación.',
  'una licencia resuelta no se puede aprobar por segunda vez'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.absence_decisions ad
    where ad.absence_record_id = 'a7000000-0000-4000-8000-000000000301'
  ),
  2,
  'el reintento rechazado no crea otra decisión'
);

-- Segundo caso sin decisión previa: aprobar debe crear igualmente el cierre.
insert into public.absence_records (
  id, employee_id, absence_type_id, start_date, end_date, source,
  source_hash, created_by
) values (
  'a7000000-0000-4000-8000-000000000302',
  'a7000000-0000-4000-8000-000000000201',
  (select at.id from public.absence_types at where at.code = 'MEDICAL_LEAVE'),
  date '2099-10-01', date '2099-10-01', 'manual',
  'test-medical-close-107-2',
  'a7000000-0000-4000-8000-000000000101'
);

insert into public.supporting_documents (
  id, employee_id, absence_record_id, document_type, storage_path, mime_type,
  original_filename, uploaded_by
) values (
  'a7000000-0000-4000-8000-000000000402',
  'a7000000-0000-4000-8000-000000000201',
  'a7000000-0000-4000-8000-000000000302',
  'MEDICAL_CERTIFICATE', 'test-only/license-close-107-2.pdf',
  'application/pdf', 'license-close-107-2.pdf',
  'a7000000-0000-4000-8000-000000000101'
);

insert into public.medical_license_approvals (
  id, absence_record_id, supporting_document_id, proposed_start_date,
  proposed_end_date, extraction_status, uploaded_by
) values (
  'a7000000-0000-4000-8000-000000000502',
  'a7000000-0000-4000-8000-000000000302',
  'a7000000-0000-4000-8000-000000000402',
  date '2099-10-01', date '2099-10-01', 'EXTRAIDO',
  'a7000000-0000-4000-8000-000000000101'
);

set local role authenticated;
set local request.jwt.claim.sub = 'a7000000-0000-4000-8000-000000000102';
set local request.jwt.claim.aal = 'aal2';

select lives_ok(
  $$ select public.approve_medical_license(
       'a7000000-0000-4000-8000-000000000502',
       date '2099-10-01', date '2099-10-01'
     ) $$,
  'aprobar una ausencia sin decisión previa también funciona'
);

reset role;

select is(
  (
    select count(*)::integer
    from public.absence_decisions ad
    where ad.absence_record_id = 'a7000000-0000-4000-8000-000000000302'
      and ad.is_current
      and ad.decision_status = 'CONFIRMED'
  ),
  1,
  'la aprobación crea el cierre aunque no existiera una decisión previa'
);

select is(
  (
    select count(*)::integer
    from public.attendance_status_records asr
    join public.attendance_statuses ats on ats.id = asr.attendance_status_id
    where asr.employee_id = 'a7000000-0000-4000-8000-000000000201'
      and asr.work_date = date '2099-10-01'
      and asr.is_current
      and ats.code = 'L'
  ),
  1,
  'el segundo caso también queda reflejado como L en asistencia'
);

select is(
  (
    select count(*)::integer
    from public.absence_decisions ad
    where ad.absence_record_id in (
      'a7000000-0000-4000-8000-000000000301',
      'a7000000-0000-4000-8000-000000000302'
    )
      and ad.is_current
      and ad.decision_status <> 'CONFIRMED'
  ),
  0,
  'ninguna licencia aprobada del fixture queda pendiente de decisión'
);

select * from finish();
rollback;
