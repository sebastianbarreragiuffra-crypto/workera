-- P0-A: gate transitorio ARCOTEX para exportaciones laborales heredadas.
create extension if not exists pgtap;
begin;
select plan(43);

select has_function(
  'public', 'authorize_workforce_data_access', array['text','uuid','text','date','date'],
  '1) existe RPC de autorizacion laboral'
);
select has_function(
  'public', 'can_read_supplier_master_path', array['text'],
  '2) existe helper de Storage para maestro activo'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.authorize_workforce_data_access(text,uuid,text,date,date)',
    'EXECUTE'
  ),
  '3) authenticated puede entrar solo por RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.authorize_workforce_data_access(text,uuid,text,date,date)',
    'EXECUTE'
  ),
  '4) anon no puede autorizar exportaciones'
);
select ok(
  not has_table_privilege('authenticated', 'public.workforce_data_access_limits', 'SELECT'),
  '5) cliente no inspecciona ni modifica cuotas'
);
select ok(
  (select pg_get_constraintdef(oid)
   from pg_constraint
   where conrelid='public.workforce_data_access_limits'::regclass
     and conname='workforce_data_access_limits_scope_check')
    ~ 'attendance.export.*payroll_batch.export.*supplier_master.download',
  '6) constraint cierra las tres superficies nuevas'
);
select ok(
  (select prosecdef from pg_proc
   where oid='public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure),
  '7) RPC es security definer para cuota y auditoria atomicas'
);
select is(
  (select proconfig[1] from pg_proc
   where oid='public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure),
  'search_path=""',
  '8) RPC fija search_path vacio'
);
select ok(
  pg_get_functiondef('public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure)
    ~* 'on conflict',
  '9) cuota usa UPSERT serializable por clave'
);
select ok(
  pg_get_functiondef('public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure)
    ~ $$v_event_prefix := 'ATTENDANCE_EXPORT'$$
  and pg_get_functiondef('public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure)
    ~ $$v_event_prefix := 'PAYROLL_BATCH_EXPORT'$$
  and pg_get_functiondef('public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure)
    ~ $$v_event_prefix := 'SUPPLIER_MASTER_DOWNLOAD'$$
  and pg_get_functiondef('public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure)
    ~ $$_AUTHORIZED'$$,
  '10) cada descarga deja un evento allowlisted'
);
select ok(
  pg_get_functiondef('public.authorize_workforce_data_access(text,uuid,text,date,date)'::regprocedure)
    ~ $$slug = 'arcotex'$$,
  '11) el gate declara explicitamente su alcance legacy ARCOTEX'
);
select ok(
  (select qual::text like '%can_read_supplier_master_path%'
   from pg_policies
   where schemaname='storage' and tablename='objects'
     and policyname='supplier_master_files_storage_select'),
  '12) Storage revalida ruta activa, empresa y MFA'
);

insert into public.profiles (id, display_name, role, active) values
  ('76000000-0000-4000-8000-000000000101', 'Admin exportaciones', 'ADMIN_RRHH', true),
  ('76000000-0000-4000-8000-000000000102', 'Supervisor exportaciones', 'SUPERVISOR_PRODUCTION', true),
  ('76000000-0000-4000-8000-000000000103', 'Admin revocado', 'ADMIN_RRHH', true);

update public.company_memberships
set active=false
where user_id='76000000-0000-4000-8000-000000000103'
  and company_id='0a4c0000-0000-0000-0000-000000000001';

insert into public.payroll_batches (
  id, source_filename, generated_by, matched_count, unmatched_count, total_amount
) values (
  '76000000-0000-4000-8000-000000000201', 'lote-prueba.xlsx',
  '76000000-0000-4000-8000-000000000101', 1, 0, 1000
);

update public.supplier_master_imports
set status='REPLACED',
    activated_at=coalesce(activated_at, now()),
    replaced_at=coalesce(replaced_at, now())
where status='ACTIVE';

insert into public.supplier_master_imports (
  id, uploaded_by, original_filename, storage_path, file_size, row_count,
  inserted_count, updated_count, unchanged_count, rejected_count,
  status, activated_at
) values (
  '76000000-0000-4000-8000-000000000301',
  '76000000-0000-4000-8000-000000000101',
  'maestro-proveedores.xlsx', 'imports/maestro-proveedores.xlsx', 1024, 1,
  1, 0, 0, 0, 'ACTIVE', now()
);

create temporary table test_workforce_access (
  allowed boolean,
  request_limit integer,
  remaining integer,
  retry_after_seconds integer,
  storage_path text,
  original_filename text
);
grant all on test_workforce_access to authenticated;

set local role authenticated;
select throws_ok(
  $$select * from public.authorize_workforce_data_access('attendance.export', null, 'SEMANAL', '2026-09-01', '2026-09-07')$$,
  '42501', 'Autenticacion requerida.',
  '13) sin identidad falla cerrado'
);

set local request.jwt.claim.sub = '76000000-0000-4000-8000-000000000102';
set local request.jwt.claim.aal = 'aal1';
select lives_ok(
  $$insert into test_workforce_access
    select * from public.authorize_workforce_data_access(
      'attendance.export', null, 'SEMANAL', '2026-09-01', '2026-09-07'
    )$$,
  '14) supervisor miembro puede autorizar asistencia'
);
select ok((select allowed from test_workforce_access), '15) primera asistencia queda permitida');
select is((select request_limit from test_workforce_access), 20, '16) asistencia usa limite conservador por hora');
select is((select remaining from test_workforce_access), 19, '17) contador consume una unidad');
select is((select storage_path from test_workforce_access), null, '18) asistencia nunca devuelve ruta Storage');
reset role;
select is(
  (select count(*)::integer from public.audit_log
   where actor_id='76000000-0000-4000-8000-000000000102'
     and action='ATTENDANCE_EXPORT_AUTHORIZED'
     and metadata->>'period_type'='SEMANAL'
     and metadata->>'period_start'='2026-09-01'
     and metadata->>'period_end'='2026-09-07'),
  1,
  '19) auditoria conserva empresa y periodo minimizado'
);

set local role authenticated;
set local request.jwt.claim.sub = '76000000-0000-4000-8000-000000000102';
select throws_ok(
  $$select * from public.authorize_workforce_data_access(
      'payroll_batch.export', '76000000-0000-4000-8000-000000000201'
    )$$,
  '42501', 'Acceso no autorizado.',
  '20) supervisor no descarga nomina'
);
select throws_ok(
  $$select * from public.authorize_workforce_data_access(
      'attendance.export', '76000000-0000-4000-8000-000000000201',
      'SEMANAL', '2026-09-01', '2026-09-07'
    )$$,
  '22023', 'Periodo invalido.',
  '21) asistencia no acepta recurso inyectado'
);
select throws_ok(
  $$select * from public.authorize_workforce_data_access(
      'attendance.export', null, null, '2026-09-01', '2026-09-07'
    )$$,
  '22023', 'Periodo invalido.',
  '22) tipo de periodo es obligatorio'
);
select throws_ok(
  $$select * from public.authorize_workforce_data_access(
      'attendance.export', null, 'MENSUAL', '2026-01-01', '2026-04-01'
    )$$,
  '22023', 'Periodo invalido.',
  '23) rango arbitrario extenso se rechaza'
);
select throws_ok(
  $$select * from public.authorize_workforce_data_access('superficie.inventada')$$,
  '22023', 'Superficie no permitida.',
  '24) scope fuera de allowlist se rechaza'
);

set local request.jwt.claim.sub = '76000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal1';
select throws_ok(
  $$select * from public.authorize_workforce_data_access(
      'payroll_batch.export', '76000000-0000-4000-8000-000000000201'
    )$$,
  '42501', 'Acceso no autorizado.',
  '25) admin privilegiado en AAL1 queda fuera'
);

set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select * from public.authorize_workforce_data_access(
      'payroll_batch.export', '76000000-0000-4000-8000-000000000299'
    )$$,
  '42501', 'Acceso no autorizado.',
  '26) lote inexistente no confirma existencia'
);
delete from test_workforce_access;
insert into test_workforce_access
select * from public.authorize_workforce_data_access(
  'payroll_batch.export', '76000000-0000-4000-8000-000000000201'
);
select ok((select allowed from test_workforce_access), '27) admin AAL2 descarga lote real');
select is((select request_limit from test_workforce_access), 20, '28) lote tiene cuota por hora');
select is((select remaining from test_workforce_access), 19, '29) lote consume contador propio');

delete from test_workforce_access;
insert into test_workforce_access
select * from public.authorize_workforce_data_access('supplier_master.download');
select ok((select allowed from test_workforce_access), '30) admin AAL2 descarga maestro activo');
select is((select request_limit from test_workforce_access), 10, '31) maestro usa cuota mas estricta');
select is((select storage_path from test_workforce_access), 'imports/maestro-proveedores.xlsx', '32) ruta sale solo del registro ACTIVE');
select is((select original_filename from test_workforce_access), 'maestro-proveedores.xlsx', '33) filename sale de metadata confiable');
select ok(public.can_read_supplier_master_path('imports/maestro-proveedores.xlsx'), '34) policy acepta ruta ACTIVE exacta');
select ok(not public.can_read_supplier_master_path('imports/otro.xlsx'), '35) policy rechaza ruta no registrada');

set local request.jwt.claim.aal = 'aal1';
select ok(not public.can_read_supplier_master_path('imports/maestro-proveedores.xlsx'), '36) policy rechaza AAL1 privilegiado');
set local request.jwt.claim.aal = 'aal2';

reset role;
update public.workforce_data_access_limits
set request_count=10
where actor_id='76000000-0000-4000-8000-000000000101'
  and company_id='0a4c0000-0000-0000-0000-000000000001'
  and scope='supplier_master.download';

set local role authenticated;
set local request.jwt.claim.sub = '76000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
delete from test_workforce_access;
insert into test_workforce_access
select * from public.authorize_workforce_data_access('supplier_master.download');
select ok(not (select allowed from test_workforce_access), '37) solicitud once queda bloqueada');
select ok(
  (select storage_path is null and original_filename is null from test_workforce_access),
  '38) 429 nunca filtra ruta ni filename'
);
select ok((select retry_after_seconds between 1 and 3600 from test_workforce_access), '39) Retry-After deriva de ventana real');
do $$
begin
  for i in 1..10 loop
    perform * from public.authorize_workforce_data_access('supplier_master.download');
  end loop;
end;
$$;
reset role;
select is(
  (select request_count from public.workforce_data_access_limits
   where actor_id='76000000-0000-4000-8000-000000000101'
     and scope='supplier_master.download'),
  12,
  '40) trafico bloqueado se satura en limite mas dos'
);
select is(
  (select count(*)::integer from public.audit_log
   where actor_id='76000000-0000-4000-8000-000000000101'
     and action='SUPPLIER_MASTER_DOWNLOAD_RATE_LIMITED'),
  1,
  '41) bloqueo repetido no amplifica auditoria'
);
select is(
  (select count(*)::integer from public.workforce_data_access_limits
   where actor_id='76000000-0000-4000-8000-000000000101'),
  2,
  '42) scopes de nomina y maestro mantienen contadores independientes'
);

set local role authenticated;
set local request.jwt.claim.sub = '76000000-0000-4000-8000-000000000103';
set local request.jwt.claim.aal = 'aal2';
select throws_ok(
  $$select * from public.authorize_workforce_data_access('supplier_master.download')$$,
  '42501', 'Acceso no autorizado.',
  '43) revocar membresia corta exportaciones aunque el rol global siga activo'
);

select * from finish();
rollback;
