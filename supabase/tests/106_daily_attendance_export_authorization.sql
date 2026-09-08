-- pgTAP: la descarga diaria atraviesa el mismo gate autenticado y auditado.
create extension if not exists pgtap;

begin;
select plan(5);

select ok(
  pg_catalog.strpos(
    pg_get_functiondef(
      'public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure
    ),
    '''DIARIO'''
  ) > 0,
  'el gate declara DIARIO como ventana de asistencia permitida'
);

insert into public.profiles (id, display_name, role, active)
values (
  '10600000-0000-4000-8000-000000000101',
  'RRHH descarga diaria 106', 'ADMIN_RRHH', true
);

create temporary table test_daily_export_result_106 (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer,
  storage_path text,
  original_filename text
);
grant all on test_daily_export_result_106 to authenticated;

set local role authenticated;
set local request.jwt.claim.sub = '10600000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"10600000-0000-4000-8000-000000000101","aal":"aal2"}';

insert into test_daily_export_result_106
select * from public.authorize_workforce_data_access(
  'attendance.export', null, 'DIARIO', '2026-08-10', '2026-08-10'
);

select ok(
  (select allowed and request_limit = 20 and remaining = 19
   from test_daily_export_result_106),
  'RRHH con MFA puede autorizar una descarga DIARIO de un día'
);

select throws_ok(
  $$select * from public.authorize_workforce_data_access(
      'attendance.export', null, 'DIARIO', '2026-08-10', '2026-08-11'
    )$$,
  '22023',
  'Periodo invalido.',
  'DIARIO rechaza una ventana de más de un día'
);

select throws_ok(
  $$select * from public.authorize_workforce_data_access(
      'attendance.export', null, 'TRIMESTRAL', '2026-08-10', '2026-08-10'
    )$$,
  '22023',
  'Periodo invalido.',
  'el gate sigue rechazando tipos de período desconocidos'
);

reset role;
set local request.jwt.claims = '';

select ok(
  exists (
    select 1
    from public.audit_log
    where actor_id = '10600000-0000-4000-8000-000000000101'
      and action = 'ATTENDANCE_EXPORT_AUTHORIZED'
      and metadata ->> 'period_type' = 'DIARIO'
      and metadata ->> 'period_start' = '2026-08-10'
      and metadata ->> 'period_end' = '2026-08-10'
  ),
  'la descarga diaria autorizada queda auditada con sus fechas exactas'
);

select * from finish();
rollback;
