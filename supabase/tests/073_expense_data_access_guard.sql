-- pgTAP P0-A: toda entrega financiera de Rendiciones revalida tenant/recurso,
-- consume una cuota distribuida y deja evidencia atomica.
create extension if not exists pgtap;

begin;
select plan(35);

select has_table('public', 'expense_data_access_limits', 'existe el contador distribuido');
select has_column('public', 'expense_data_access_limits', 'company_id', 'el limite esta particionado por empresa');
select has_column('public', 'expense_data_access_limits', 'actor_id', 'el limite esta particionado por actor');
select has_column('public', 'expense_data_access_limits', 'scope', 'el limite esta particionado por superficie');
select has_function(
  'public', 'authorize_expense_data_access', array['uuid','text','uuid'],
  'existe la autorizacion atomica de entrega'
);
select ok(
  has_function_privilege('authenticated', 'public.authorize_expense_data_access(uuid,text,uuid)', 'EXECUTE'),
  'una sesion autenticada entra solo por el RPC'
);
select ok(
  not has_function_privilege('anon', 'public.authorize_expense_data_access(uuid,text,uuid)', 'EXECUTE'),
  'anon no puede consumir ni autorizar entregas'
);
select ok(
  not has_table_privilege('authenticated', 'public.expense_data_access_limits', 'SELECT'),
  'el navegador no inspecciona contadores de otros actores'
);
select ok(
  pg_get_functiondef('public.authorize_expense_data_access(uuid,text,uuid)'::regprocedure)
    ~ 'company_has_module'
  and pg_get_functiondef('public.authorize_expense_data_access(uuid,text,uuid)'::regprocedure)
    ~ 'is_active_company_member',
  'el RPC revalida modulo y membresia en base'
);
select ok(
  pg_get_functiondef('public.authorize_expense_data_access(uuid,text,uuid)'::regprocedure)
    ~* 'security_status in',
  'el RPC nunca autoriza bytes en cuarentena'
);
select ok(
  pg_get_functiondef('public.authorize_expense_data_access(uuid,text,uuid)'::regprocedure)
    ~* 'on conflict',
  'el contador usa una actualizacion atomica'
);
select ok(
  pg_get_functiondef('public.authorize_expense_data_access(uuid,text,uuid)'::regprocedure)
    ~ 'expense_data_access.rate_limited'
  and pg_get_functiondef('public.authorize_expense_data_access(uuid,text,uuid)'::regprocedure)
    ~ 'expense_data_access.authorized',
  'permitir y bloquear dejan evidencia diferenciada'
);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled) values
  ('e4000000-0000-0000-0000-000000000001', 'Acceso Uno', 'Acceso Uno SpA', 'acceso-uno', true, 'ONBOARDING', false),
  ('e4000000-0000-0000-0000-000000000002', 'Acceso Dos', 'Acceso Dos SpA', 'acceso-dos', true, 'ONBOARDING', false);

insert into public.profiles (id, display_name, role, active) values
  ('e4000000-0000-0000-0000-000000000101', 'Rendidor Uno', null, true),
  ('e4000000-0000-0000-0000-000000000102', 'Finanzas Uno', null, true),
  ('e4000000-0000-0000-0000-000000000103', 'Otro Rendidor Uno', null, true),
  ('e4000000-0000-0000-0000-000000000104', 'Finanzas Dos', null, true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('e4000000-0000-0000-0000-000000000201', 'e4000000-0000-0000-0000-000000000101', 'e4000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('e4000000-0000-0000-0000-000000000202', 'e4000000-0000-0000-0000-000000000102', 'e4000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('e4000000-0000-0000-0000-000000000203', 'e4000000-0000-0000-0000-000000000103', 'e4000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('e4000000-0000-0000-0000-000000000204', 'e4000000-0000-0000-0000-000000000104', 'e4000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true);

insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
 and cr.code = case cm.id
   when 'e4000000-0000-0000-0000-000000000201' then 'PRODUCTION_SUPERVISOR'
   when 'e4000000-0000-0000-0000-000000000203' then 'PRODUCTION_SUPERVISOR'
   else 'HR_ADMIN'
 end
where cm.id in (
  'e4000000-0000-0000-0000-000000000201',
  'e4000000-0000-0000-0000-000000000202',
  'e4000000-0000-0000-0000-000000000203',
  'e4000000-0000-0000-0000-000000000204'
);

update public.company_modules
set status = 'PILOT', enabled_at = now(),
    settings = jsonb_set(settings, '{expense_accounting_export_enabled}', 'true'::jsonb, true)
where company_id in (
  'e4000000-0000-0000-0000-000000000001',
  'e4000000-0000-0000-0000-000000000002'
) and module_key = 'expenses';

insert into public.expense_categories (id, company_id, code, name, requires_receipt)
values ('e4000000-0000-0000-0000-000000000301', 'e4000000-0000-0000-0000-000000000001', 'ACCESS', 'Acceso', true);
insert into public.expense_reports (id, company_id, submitted_by, title) values (
  'e4000000-0000-0000-0000-000000000401',
  'e4000000-0000-0000-0000-000000000001',
  'e4000000-0000-0000-0000-000000000101',
  'Rendicion protegida'
);
insert into public.expense_items (
  id, company_id, report_id, category_id, expense_date, description, net_amount
) values (
  'e4000000-0000-0000-0000-000000000501',
  'e4000000-0000-0000-0000-000000000001',
  'e4000000-0000-0000-0000-000000000401',
  'e4000000-0000-0000-0000-000000000301', current_date, 'Acceso protegido', 1000
);

insert into public.expense_receipts (
  id, company_id, report_id, item_id, version, storage_path, original_filename,
  mime_type, file_size, checksum_sha256, uploaded_by
) values (
  'e4000000-0000-0000-0000-000000000601',
  'e4000000-0000-0000-0000-000000000001',
  'e4000000-0000-0000-0000-000000000401',
  'e4000000-0000-0000-0000-000000000501', 1, 'access/receipt.pdf',
  'receipt.pdf', 'application/pdf', 100, repeat('a', 64),
  'e4000000-0000-0000-0000-000000000101'
);
insert into public.expense_receipt_captures (
  id, company_id, uploaded_by, source, storage_path, original_filename,
  mime_type, file_size, checksum_sha256
) values (
  'e4000000-0000-0000-0000-000000000602',
  'e4000000-0000-0000-0000-000000000001',
  'e4000000-0000-0000-0000-000000000101', 'WEB_UPLOAD',
  'access/capture.pdf', 'capture.pdf', 'application/pdf', 100, repeat('b', 64)
);
update public.expense_reports
set status = 'PAID', submitted_at = now(), resolved_at = now(), paid_at = now(),
    paid_by = 'e4000000-0000-0000-0000-000000000102',
    payment_reference = 'PAGO-ACCESS-1'
where id = 'e4000000-0000-0000-0000-000000000401';
insert into public.expense_accounting_exports (
  id, company_id, report_id, idempotency_key, payload_sha256, payload, requested_by
) values (
  'e4000000-0000-0000-0000-000000000701',
  'e4000000-0000-0000-0000-000000000001',
  'e4000000-0000-0000-0000-000000000401', repeat('c', 64), repeat('d', 64),
  '{"schemaVersion":1,"provider":"LEDGER_CSV_V1","company":{},"report":{},"lines":[]}'::jsonb,
  'e4000000-0000-0000-0000-000000000102'
);

set local role authenticated;
set local request.jwt.claim.sub = 'e4000000-0000-0000-0000-000000000101';
create temporary table receipt_access as
select * from public.authorize_expense_data_access(
  'e4000000-0000-0000-0000-000000000001', 'receipt.download',
  'e4000000-0000-0000-0000-000000000601'
);
select ok((select allowed from receipt_access), 'el propietario obtiene su comprobante');
select is((select request_limit from receipt_access), 60, 'la descarga breve tolera uso normal de interfaz');
select is((select remaining from receipt_access), 59, 'la primera entrega consume exactamente una unidad');
select is((select retry_after_seconds from receipt_access), 0, 'una entrega autorizada no pide reintento');
reset role;
select is(
  (select count(*)::integer from public.expense_audit_events
   where actor_id = 'e4000000-0000-0000-0000-000000000101'
     and report_id = 'e4000000-0000-0000-0000-000000000401'
     and event_type = 'expense_data_access.authorized'
     and metadata->>'scope' = 'receipt.download'),
  1, 'la autorizacion queda ligada a actor, empresa y rendicion'
);
set local role authenticated;
set local request.jwt.claim.sub = 'e4000000-0000-0000-0000-000000000101';
select ok((select allowed from public.authorize_expense_data_access(
  'e4000000-0000-0000-0000-000000000001', 'capture.download',
  'e4000000-0000-0000-0000-000000000602'
)), 'el dueño puede abrir su captura liberada');
select throws_ok(
  $$select public.authorize_expense_data_access(
    'e4000000-0000-0000-0000-000000000001', 'accounting.export',
    'e4000000-0000-0000-0000-000000000701'
  )$$,
  '42501', 'Acceso no autorizado.', 'un rendidor no descarga el snapshot contable'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'e4000000-0000-0000-0000-000000000103';
select throws_ok(
  $$select public.authorize_expense_data_access(
    'e4000000-0000-0000-0000-000000000001', 'receipt.download',
    'e4000000-0000-0000-0000-000000000601'
  )$$,
  '42501', 'Acceso no autorizado.', 'otro rendidor de la misma empresa no ve el comprobante'
);
select throws_ok(
  $$select public.authorize_expense_data_access(
    'e4000000-0000-0000-0000-000000000001', 'capture.download',
    'e4000000-0000-0000-0000-000000000602'
  )$$,
  '42501', 'Acceso no autorizado.', 'otro rendidor no ve la captura ajena'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'e4000000-0000-0000-0000-000000000104';
select throws_ok(
  $$select public.authorize_expense_data_access(
    'e4000000-0000-0000-0000-000000000001', 'reconciliation.export', null
  )$$,
  '42501', 'Acceso no autorizado.', 'un miembro de otro tenant no consume el limite ajeno'
);
reset role;

update public.expense_receipts
set security_status = 'PENDING_SCAN'
where id = 'e4000000-0000-0000-0000-000000000601';
set local role authenticated;
set local request.jwt.claim.sub = 'e4000000-0000-0000-0000-000000000101';
select throws_ok(
  $$select public.authorize_expense_data_access(
    'e4000000-0000-0000-0000-000000000001', 'receipt.download',
    'e4000000-0000-0000-0000-000000000601'
  )$$,
  '42501', 'Acceso no autorizado.', 'un archivo en cuarentena no se libera por el RPC'
);
select throws_ok(
  $$select public.authorize_expense_data_access(
    'e4000000-0000-0000-0000-000000000001', 'scope.inventado', null
  )$$,
  '22023', 'Superficie no permitida.', 'la superficie es una allowlist cerrada'
);
select throws_ok(
  $$select public.authorize_expense_data_access(
    'e4000000-0000-0000-0000-000000000001', 'receipt.download', null
  )$$,
  '22023', 'Recurso requerido.', 'una descarga individual exige UUID'
);
select throws_ok(
  $$select public.authorize_expense_data_access(
    'e4000000-0000-0000-0000-000000000001', 'reconciliation.export',
    'e4000000-0000-0000-0000-000000000601'
  )$$,
  '22023', 'Esta superficie no acepta recurso.', 'un export agregado rechaza UUID ambiguo'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'e4000000-0000-0000-0000-000000000102';
select ok((select allowed from public.authorize_expense_data_access(
  'e4000000-0000-0000-0000-000000000001', 'accounting.export',
  'e4000000-0000-0000-0000-000000000701'
)), 'finanzas puede descargar el snapshot de su empresa');
create temporary table reconciliation_first as
select * from public.authorize_expense_data_access(
  'e4000000-0000-0000-0000-000000000001', 'reconciliation.export', null
);
select ok((select allowed from reconciliation_first), 'finanzas inicia la ventana de exportacion');
select is((select request_limit from reconciliation_first), 10, 'la exportacion masiva usa limite conservador por hora');
do $$
begin
  for i in 1..9 loop
    perform * from public.authorize_expense_data_access(
      'e4000000-0000-0000-0000-000000000001', 'reconciliation.export', null
    );
  end loop;
end;
$$;
create temporary table reconciliation_blocked as
select * from public.authorize_expense_data_access(
  'e4000000-0000-0000-0000-000000000001', 'reconciliation.export', null
);
select ok(not (select allowed from reconciliation_blocked), 'la solicitud once se bloquea en base');
select is((select remaining from reconciliation_blocked), 0, 'el bloqueo no produce saldo negativo');
select ok((select retry_after_seconds between 1 and 3600 from reconciliation_blocked), 'Retry-After sale de la ventana real');
do $$
begin
  for i in 1..20 loop
    perform * from public.authorize_expense_data_access(
      'e4000000-0000-0000-0000-000000000001', 'reconciliation.export', null
    );
  end loop;
end;
$$;
reset role;
select is(
  (select request_count from public.expense_data_access_limits
   where company_id = 'e4000000-0000-0000-0000-000000000001'
     and actor_id = 'e4000000-0000-0000-0000-000000000102'
     and scope = 'reconciliation.export'),
  12, 'el contador se satura sin crecer bajo trafico bloqueado'
);
select is(
  (select count(*)::integer from public.expense_audit_events
   where actor_id = 'e4000000-0000-0000-0000-000000000102'
     and event_type = 'expense_data_access.rate_limited'
     and metadata->>'scope' = 'reconciliation.export'),
  1, 'los bloqueos repetidos no amplifican el ledger de auditoria'
);
select is(
  (select count(*)::integer from public.expense_data_access_limits
   where company_id = 'e4000000-0000-0000-0000-000000000001'
     and actor_id = 'e4000000-0000-0000-0000-000000000102'
     and scope = 'reconciliation.export'),
  1, 'la tabla mantiene cardinalidad acotada por actor/scope'
);

select * from finish();
rollback;
