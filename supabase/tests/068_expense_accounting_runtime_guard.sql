-- pgTAP GESTORA Fase 4B: la pausa contable se impone en base, no solo en UI.
create extension if not exists pgtap;

begin;
select plan(27);

select has_function(
  'public', 'enforce_expense_accounting_enqueue_enabled', array[]::text[],
  'existe guarda autoritativa del piloto'
);
select has_trigger(
  'public', 'expense_accounting_exports', 'expense_accounting_exports_enqueue_guard',
  'todo insert del outbox pasa por la guarda'
);
select ok(
  not has_function_privilege('authenticated', 'public.enforce_expense_accounting_enqueue_enabled()', 'EXECUTE'),
  'el navegador no invoca la función de trigger'
);
select ok(
  not has_function_privilege('service_role', 'public.enforce_expense_accounting_enqueue_enabled()', 'EXECUTE'),
  'service role tampoco salta el trigger directamente'
);
select has_function(
  'public', 'platform_set_expense_accounting_pilot', array['uuid','boolean','text'],
  'existe operación auditada del control plane'
);
select ok(
  has_function_privilege('authenticated', 'public.platform_set_expense_accounting_pilot(uuid,boolean,text)', 'EXECUTE'),
  'la sesión autenticada entra por el RPC que valida el rol de plataforma'
);
select is(
  (select count(*)::integer from regexp_matches(
    pg_get_functiondef('public.platform_set_expense_accounting_pilot(uuid,boolean,text)'::regprocedure),
    'can_manage_platform\(\)', 'g'
  )),
  2,
  'el RPC revalida el rol después de adquirir el lock'
);
select ok(
  pg_get_functiondef('public.claim_expense_accounting_exports(integer)'::regprocedure)
    ~ 'join public.companies c'
  and pg_get_functiondef('public.claim_expense_accounting_exports(integer)'::regprocedure)
    ~ 'c.active'
  and pg_get_functiondef('public.claim_expense_accounting_exports(integer)'::regprocedure)
    ~ 'expense_accounting_export_enabled',
  'la migración forward redefine claim con ciclo de vida y flag tenant-aware'
);
select ok(
  pg_get_functiondef(
    'public.complete_expense_accounting_export(uuid,uuid,boolean,text,text,text,boolean)'::regprocedure
  ) ~ $$v_error_code in \('RATE_LIMIT'\)$$,
  'la base impone una allowlist cerrada de retry financiero'
);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values ('d2000000-0000-0000-0000-000000000001', 'Runtime Guard', 'Runtime Guard SpA', 'runtime-guard', true, 'ONBOARDING', false);
insert into public.profiles (id, display_name, role, active)
values
  ('d2000000-0000-0000-0000-000000000101', 'Operador Runtime', null, true),
  ('d2000000-0000-0000-0000-000000000102', 'Admin Runtime', null, true);
insert into public.platform_memberships (user_id, role, active)
values ('d2000000-0000-0000-0000-000000000102', 'ADMIN', true);
insert into public.expense_reports (
  id, company_id, submitted_by, title, currency_code, status, submitted_at,
  paid_at, paid_by, payment_reference
) values (
  'd2000000-0000-0000-0000-000000000301',
  'd2000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000101',
  'Salida protegida', 'CLP', 'PAID', now(), now(),
  'd2000000-0000-0000-0000-000000000101', 'PAGO-RUNTIME-1'
);
update public.company_modules
set status = 'PILOT', enabled_at = now(),
    settings = jsonb_set(settings, '{expense_accounting_export_enabled}', 'false'::jsonb, true)
where company_id = 'd2000000-0000-0000-0000-000000000001' and module_key = 'expenses';

select is(
  (select settings->>'expense_accounting_export_enabled'
   from public.company_modules
   where company_id = 'd2000000-0000-0000-0000-000000000001' and module_key = 'expenses'),
  'false',
  'el piloto parte pausado en base'
);

select throws_ok(
  $$
    insert into public.expense_accounting_exports (
      company_id, report_id, idempotency_key, payload_sha256, payload, requested_by
    ) values (
      'd2000000-0000-0000-0000-000000000001',
      'd2000000-0000-0000-0000-000000000301',
      repeat('a', 64), repeat('b', 64),
      '{"schemaVersion":1,"provider":"LEDGER_CSV_V1","company":{},"report":{},"lines":[]}'::jsonb,
      'd2000000-0000-0000-0000-000000000101'
    )
  $$,
  '55000', 'La integración contable está pausada para esta empresa.',
  'un insert directo tampoco salta la pausa'
);
select is(
  (select count(*)::integer from public.expense_accounting_exports),
  0,
  'la pausa no deja trabajo huérfano'
);

set local role authenticated;
set local request.jwt.claim.sub = 'd2000000-0000-0000-0000-000000000101';
select throws_ok(
  $$select public.platform_set_expense_accounting_pilot(
    'd2000000-0000-0000-0000-000000000001', true, 'Intento sin rol de plataforma'
  )$$,
  '42501', 'Tu rol no permite operar el piloto contable.',
  'un usuario común no activa el piloto'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'd2000000-0000-0000-0000-000000000102';
select is(
  public.platform_set_expense_accounting_pilot(
    'd2000000-0000-0000-0000-000000000001', true, 'Activación controlada de marcha blanca'
  ),
  true,
  'plataforma activa el canario'
);
reset role;
select is(
  (select settings_version from public.company_modules
   where company_id = 'd2000000-0000-0000-0000-000000000001' and module_key = 'expenses'),
  2,
  'la activación incrementa la versión de settings'
);
select is(
  (select count(*)::integer from public.platform_audit_log
   where company_id = 'd2000000-0000-0000-0000-000000000001'
     and action = 'company.expense_accounting_pilot.changed'),
  1,
  'la activación deja auditoría append-only'
);

select lives_ok(
  $$
    insert into public.expense_accounting_exports (
      company_id, report_id, idempotency_key, payload_sha256, payload, requested_by
    ) values (
      'd2000000-0000-0000-0000-000000000001',
      'd2000000-0000-0000-0000-000000000301',
      repeat('a', 64), repeat('b', 64),
      '{"schemaVersion":1,"provider":"LEDGER_CSV_V1","company":{},"report":{},"lines":[]}'::jsonb,
      'd2000000-0000-0000-0000-000000000101'
    )
  $$,
  'el flag tenant-aware habilita el piloto'
);
select is(
  (select count(*)::integer from public.expense_accounting_exports),
  1,
  'la habilitación crea exactamente una salida'
);

set local role service_role;
create temporary table f4_runtime_claim as
select * from public.claim_expense_accounting_exports(1);
select is((select count(*)::integer from f4_runtime_claim), 1, 'worker reclama el piloto activo');
select is(
  public.complete_expense_accounting_export(
    (select export_id from f4_runtime_claim),
    (select lease_token from f4_runtime_claim),
    false, null, 'PROVIDER_TIMEOUT', 'Resultado externo incierto.', true
  )::text,
  'FAILED',
  'un adapter no puede convertir un timeout en retry'
);
reset role;
select is(
  (select status::text from public.expense_accounting_exports),
  'FAILED',
  'el timeout queda disponible para reconciliación humana'
);
update public.expense_accounting_exports
set status = 'QUEUED', attempt_count = 0, available_at = now(),
    lease_token = null, lease_expires_at = null,
    last_error_code = null, last_error_summary = null;

set local role authenticated;
set local request.jwt.claim.sub = 'd2000000-0000-0000-0000-000000000102';
select is(
  public.platform_set_expense_accounting_pilot(
    'd2000000-0000-0000-0000-000000000001', false, 'Pausa controlada de marcha blanca'
  ),
  false,
  'plataforma pausa el canario'
);
reset role;
select is(
  (select settings_version from public.company_modules
   where company_id = 'd2000000-0000-0000-0000-000000000001' and module_key = 'expenses'),
  3,
  'la pausa también incrementa la versión'
);
select is(
  (select count(*)::integer from public.platform_audit_log
   where company_id = 'd2000000-0000-0000-0000-000000000001'
     and action = 'company.expense_accounting_pilot.changed'),
  2,
  'la pausa queda auditada'
);
set local role service_role;
select is(
  (select count(*)::integer from public.claim_expense_accounting_exports(10)),
  0,
  'el worker no reclama backlog de una empresa pausada'
);
reset role;

update public.companies
set active = false, status = 'SUSPENDED'
where id = 'd2000000-0000-0000-0000-000000000001';
update public.company_modules
set settings = jsonb_set(settings, '{expense_accounting_export_enabled}', 'true'::jsonb, true)
where company_id = 'd2000000-0000-0000-0000-000000000001' and module_key = 'expenses';
set local role authenticated;
set local request.jwt.claim.sub = 'd2000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.platform_set_expense_accounting_pilot(
    'd2000000-0000-0000-0000-000000000001', true, 'Intento sobre empresa suspendida'
  )$$,
  '55000', 'La empresa debe estar activa para operar el piloto contable.',
  'plataforma no activa contabilidad para una empresa suspendida'
);
reset role;
set local role service_role;
select is(
  (select count(*)::integer from public.claim_expense_accounting_exports(10)),
  0,
  'el worker no exporta backlog de una empresa suspendida aunque el flag siga true'
);
reset role;

select * from finish();
rollback;
