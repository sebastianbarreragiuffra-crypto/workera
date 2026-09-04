-- pgTAP GESTORA Fase 4B: DLQ, maker-checker y salud tenant-aware.
create extension if not exists pgtap;

begin;
select plan(43);

select has_column('public', 'expense_accounting_exports', 'manual_replay_count', 'outbox limita replay manual');
select has_function(
  'public', 'resolve_expense_accounting_export',
  array['uuid','uuid','text','text','text','boolean'],
  'existe reconciliación manual de DLQ'
);
select has_function('public', 'get_expense_accounting_company_health', array['uuid'], 'existe salud por empresa');
select ok(
  has_function_privilege(
    'authenticated',
    'public.resolve_expense_accounting_export(uuid,uuid,text,text,text,boolean)',
    'EXECUTE'
  ),
  'la app autenticada puede solicitar resolución'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.resolve_expense_accounting_export(uuid,uuid,text,text,text,boolean)',
    'EXECUTE'
  ),
  'anon nunca resuelve contabilidad'
);

insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled)
values
  ('c2000000-0000-0000-0000-000000000001', 'DLQ Uno', 'DLQ Uno SpA', 'dlq-uno', true, 'ONBOARDING', false),
  ('c2000000-0000-0000-0000-000000000002', 'DLQ Dos', 'DLQ Dos SpA', 'dlq-dos', true, 'ONBOARDING', false);
insert into public.profiles (id, display_name, role, active) values
  ('c2000000-0000-0000-0000-000000000101', 'Plataforma DLQ', null, true),
  ('c2000000-0000-0000-0000-000000000102', 'Rendidor DLQ', null, true),
  ('c2000000-0000-0000-0000-000000000103', 'Maker DLQ', null, true),
  ('c2000000-0000-0000-0000-000000000104', 'Checker DLQ', null, true),
  ('c2000000-0000-0000-0000-000000000105', 'Ajeno DLQ', null, true);
insert into public.platform_memberships (user_id, role, active)
values ('c2000000-0000-0000-0000-000000000101', 'ADMIN', true);
insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('c2000000-0000-0000-0000-000000000201', 'c2000000-0000-0000-0000-000000000102', 'c2000000-0000-0000-0000-000000000001', 'SUPERVISOR_PRODUCTION', true),
  ('c2000000-0000-0000-0000-000000000202', 'c2000000-0000-0000-0000-000000000103', 'c2000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('c2000000-0000-0000-0000-000000000203', 'c2000000-0000-0000-0000-000000000104', 'c2000000-0000-0000-0000-000000000001', 'ADMIN_RRHH', true),
  ('c2000000-0000-0000-0000-000000000204', 'c2000000-0000-0000-0000-000000000105', 'c2000000-0000-0000-0000-000000000002', 'ADMIN_RRHH', true);
insert into public.company_membership_roles (company_id, membership_id, role_id)
select cm.company_id, cm.id, cr.id
from public.company_memberships cm
join public.company_roles cr on cr.company_id = cm.company_id
where (cm.id = 'c2000000-0000-0000-0000-000000000201' and cr.code = 'PRODUCTION_SUPERVISOR')
   or (cm.id in (
        'c2000000-0000-0000-0000-000000000202',
        'c2000000-0000-0000-0000-000000000203',
        'c2000000-0000-0000-0000-000000000204'
      ) and cr.code = 'HR_ADMIN');

set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000101';
select public.platform_set_company_module_status('c2000000-0000-0000-0000-000000000001', 'expenses', 'PILOT');
select public.platform_set_company_module_status('c2000000-0000-0000-0000-000000000002', 'expenses', 'PILOT');
reset role;
update public.company_modules
set settings = jsonb_set(settings, '{expense_accounting_export_enabled}', 'true'::jsonb, true)
where company_id = 'c2000000-0000-0000-0000-000000000001' and module_key = 'expenses';

set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000102';
insert into public.expense_reports (id, company_id, submitted_by, title, currency_code) values
  ('c2000000-0000-0000-0000-000000000301', 'c2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000102', 'Replay DLQ', 'CLP'),
  ('c2000000-0000-0000-0000-000000000302', 'c2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000102', 'Confirmar DLQ', 'CLP'),
  ('c2000000-0000-0000-0000-000000000303', 'c2000000-0000-0000-0000-000000000001', 'c2000000-0000-0000-0000-000000000102', 'Cancelar DLQ', 'CLP');
insert into public.expense_items (id, company_id, report_id, category_id, expense_date, description, net_amount)
select ('c2000000-0000-0000-0000-00000000040' || n)::uuid,
       'c2000000-0000-0000-0000-000000000001'::uuid,
       ('c2000000-0000-0000-0000-00000000030' || n)::uuid,
       ec.id, current_date, 'Gasto DLQ ' || n, 10000 * n
from generate_series(1,3) n
cross join lateral (
  select id from public.expense_categories
  where company_id = 'c2000000-0000-0000-0000-000000000001' and code = 'OTROS'
  limit 1
) ec;
select public.submit_expense_report(('c2000000-0000-0000-0000-00000000030' || n)::uuid)
from generate_series(1,3) n;
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000103';
select public.decide_expense_report(('c2000000-0000-0000-0000-00000000030' || n)::uuid, 'APPROVED', null)
from generate_series(1,3) n;
select public.reconcile_expense_report(
  ('c2000000-0000-0000-0000-00000000030' || n)::uuid,
  'PAGO-DLQ-' || n
)
from generate_series(1,3) n;
select public.queue_expense_accounting_export(
  'c2000000-0000-0000-0000-000000000001',
  ('c2000000-0000-0000-0000-00000000030' || n)::uuid
)
from generate_series(1,3) n;
reset role;

update public.expense_accounting_exports
set status = 'FAILED', last_error_code = 'PROVIDER_TIMEOUT',
    last_error_summary = 'Estado externo incierto.';

set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000103';
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,true)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'),
    'REQUEUE', 'Confirmado ausente'
  ),
  '23514', 'La resolución requiere un segundo responsable.', 'maker no resuelve su propia salida'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000105';
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,true)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'),
    'REQUEUE', 'Confirmado ausente'
  ),
  '42501', 'Tu rol no permite resolver fallos contables.', 'otro tenant falla cerrado'
);
select throws_ok(
  $$select * from public.get_expense_accounting_company_health('c2000000-0000-0000-0000-000000000001')$$,
  '42501', 'Tu rol no permite ver la operación contable.', 'salud tampoco cruza tenants'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000104';
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,true)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'),
    'REQUEUE', 'corto'
  ),
  '23514', 'El motivo de resolución debe tener entre 8 y 240 caracteres.', 'motivo corto no es evidencia'
);
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,false)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'),
    'REQUEUE', 'Revisado en ERP y no existe'
  ),
  '23514', 'Confirma que el asiento no existe antes de reintentar.', 'replay exige confirmación explícita'
);
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,null)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'),
    'REQUEUE', 'Revisado en ERP y no existe'
  ),
  '23514', 'Confirma que el asiento no existe antes de reintentar.', 'NULL nunca equivale a confirmación de replay'
);
reset role;
update public.company_modules
set settings = jsonb_set(settings, '{expense_accounting_export_enabled}', 'false'::jsonb, true)
where company_id = 'c2000000-0000-0000-0000-000000000001' and module_key = 'expenses';
set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000104';
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,true)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'),
    'REQUEUE', 'Revisado en ERP y no existe'
  ),
  '55000', 'La integración contable está pausada para esta empresa.',
  'una empresa pausada no reencola trabajos fallidos'
);
reset role;
update public.company_modules
set settings = jsonb_set(settings, '{expense_accounting_export_enabled}', 'true'::jsonb, true)
where company_id = 'c2000000-0000-0000-0000-000000000001' and module_key = 'expenses';
set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000104';
select is(
  public.resolve_expense_accounting_export(
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'),
    'REQUEUE', 'Revisado en ERP y no existe', null, true
  )::text,
  'QUEUED', 'checker reencola tras confirmar ausencia'
);
select is((select attempt_count from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'), 0, 'replay reinicia intentos automáticos');
select is((select manual_replay_count from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'), 1, 'replay manual queda acotado');
select is((select count(*)::integer from public.expense_accounting_export_events where event_type = 'REQUEUED'), 1, 'replay queda en bitácora contable');
select is((select count(*)::integer from public.expense_audit_events where event_type = 'ACCOUNTING_EXPORT_REQUEUED'), 1, 'replay queda en auditoría de dominio');

select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,false)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000302'),
    'CONFIRM_SUCCEEDED', 'Verificado con contabilidad'
  ),
  '23514', 'Ingresa una referencia externa válida para confirmar.', 'confirmación exige referencia externa'
);
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,%L,null)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000302'),
    'CONFIRM_SUCCEEDED', 'Verificado con contabilidad', 'ASIENTO-ERP-2026-001'
  ),
  '23514', 'Ingresa una referencia externa válida para confirmar.', 'NULL no sustituye la opción explícita de confirmación'
);
select is(
  public.resolve_expense_accounting_export(
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000302'),
    'CONFIRM_SUCCEEDED', 'Verificado con contabilidad', 'ASIENTO-ERP-2026-001', false
  )::text,
  'SUCCEEDED', 'checker confirma el asiento existente'
);
select ok((select exported_at is not null from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000302'), 'confirmación fija fecha terminal');
select is((select count(*)::integer from public.expense_accounting_export_events where event_type = 'MANUAL_CONFIRMED'), 1, 'confirmación manual queda auditada');

select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,false)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000303'),
    'CANCEL', 'No corresponde exportar'
  ),
  '23514', 'Confirma que el asiento no existe antes de cancelar.', 'cancelación exige confirmar ausencia'
);
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,null)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000303'),
    'CANCEL', 'No corresponde exportar'
  ),
  '23514', 'Confirma que el asiento no existe antes de cancelar.', 'NULL nunca confirma ausencia para cancelar'
);
select is(
  public.resolve_expense_accounting_export(
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000303'),
    'CANCEL', 'No corresponde exportar', null, true
  )::text,
  'CANCELLED', 'checker cancela una salida ausente'
);
select is((select count(*)::integer from public.expense_accounting_export_events where event_type = 'CANCELLED'), 1, 'cancelación queda auditada');

create temporary table f4_company_health as
select * from public.get_expense_accounting_company_health('c2000000-0000-0000-0000-000000000001');
select ok((select enqueue_enabled from f4_company_health), 'salud expone el switch tenant-aware activo');
select is((select queued_count::integer from f4_company_health), 1, 'salud cuenta reencolados');
select is((select succeeded_count::integer from f4_company_health), 1, 'salud cuenta confirmados');
select is((select cancelled_count::integer from f4_company_health), 1, 'salud cuenta cancelados');
select is((select paused_backlog_count::integer from f4_company_health), 0, 'operación activa no reporta backlog pausado');
select ok((select not paused_with_backlog from f4_company_health), 'operación activa no se etiqueta como pausada');
select ok((select not requires_worker_recovery from f4_company_health), 'sin lease ni backlog vencido no pide recuperación técnica');
select ok((select not requires_attention from f4_company_health), 'sin DLQ ni lease vencido no exige atención');
reset role;

update public.expense_accounting_exports
set available_at = now() - interval '1 hour'
where report_id = 'c2000000-0000-0000-0000-000000000301';
update public.company_modules
set settings = jsonb_set(settings, '{expense_accounting_export_enabled}', 'false'::jsonb, true)
where company_id = 'c2000000-0000-0000-0000-000000000001' and module_key = 'expenses';
set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000104';
create temporary table f4_paused_health as
select * from public.get_expense_accounting_company_health('c2000000-0000-0000-0000-000000000001');
select ok((select not enqueue_enabled from f4_paused_health), 'salud refleja la pausa tenant-aware');
select is((select paused_backlog_count::integer from f4_paused_health), 1, 'la pausa cuenta el backlog retenido');
select ok((select paused_with_backlog from f4_paused_health), 'la pausa con trabajos tiene estado explícito');
select is((select stale_ready_count::integer from f4_paused_health), 0, 'backlog pausado no se falsea como vencido');
select ok((select not requires_worker_recovery from f4_paused_health), 'backlog pausado no pide recuperación técnica');
select ok((select not requires_attention from f4_paused_health), 'una pausa intencional no es una alerta operativa');
reset role;
update public.company_modules
set settings = jsonb_set(settings, '{expense_accounting_export_enabled}', 'true'::jsonb, true)
where company_id = 'c2000000-0000-0000-0000-000000000001' and module_key = 'expenses';

update public.expense_accounting_exports
set status = 'FAILED', manual_replay_count = 3,
    last_error_code = 'REPLAY_EXHAUSTED', last_error_summary = 'Revisión manual requerida.'
where report_id = 'c2000000-0000-0000-0000-000000000301';
set local role authenticated;
set local request.jwt.claim.sub = 'c2000000-0000-0000-0000-000000000104';
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,true)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000301'),
    'REQUEUE', 'Revisado nuevamente en ERP'
  ),
  '23514', 'La salida alcanzó el máximo de reintentos manuales.', 'DLQ limita replay infinito'
);
select ok(
  (select requires_attention from public.get_expense_accounting_company_health('c2000000-0000-0000-0000-000000000001')),
  'una salida fallida prende la alerta de la empresa'
);
select throws_ok(
  format(
    'select public.resolve_expense_accounting_export(%L,%L,%L,%L,null,true)',
    'c2000000-0000-0000-0000-000000000001',
    (select id from public.expense_accounting_exports where report_id = 'c2000000-0000-0000-0000-000000000302'),
    'REQUEUE', 'Intento sobre un éxito terminal'
  ),
  '23514', 'Solo una salida fallida puede resolverse manualmente.', 'un éxito nunca vuelve a la cola'
);
reset role;

select * from finish();
rollback;
