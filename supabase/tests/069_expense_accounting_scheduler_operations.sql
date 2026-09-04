-- pgTAP GESTORA Fase 4A: scheduler durable, fencing y watchdog contable.
create extension if not exists pgtap;

begin;
select plan(33);

select has_table('public', 'expense_accounting_worker_runs', 'existe heartbeat durable del worker');
select has_function('public', 'start_expense_accounting_worker_run', array['text'], 'existe reserva de run');
select has_function(
  'public', 'complete_expense_accounting_worker_run',
  array['uuid','uuid','boolean','integer','integer','integer','integer','text'],
  'existe cierre fenced del run'
);
select has_function('public', 'get_expense_accounting_worker_health', array['integer'], 'existe snapshot de watchdog');
select ok(
  not has_function_privilege('authenticated', 'public.start_expense_accounting_worker_run(text)', 'EXECUTE'),
  'el navegador no inicia workers'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.complete_expense_accounting_worker_run(uuid,uuid,boolean,integer,integer,integer,integer,text)',
    'EXECUTE'
  ),
  'el navegador no cierra workers'
);
select ok(
  not has_function_privilege('authenticated', 'public.get_expense_accounting_worker_health(integer)', 'EXECUTE'),
  'el navegador no obtiene salud global de otros tenants'
);
select ok(
  has_function_privilege('service_role', 'public.start_expense_accounting_worker_run(text)', 'EXECUTE'),
  'service_role puede iniciar el worker'
);
select ok(
  not has_table_privilege('service_role', 'public.expense_accounting_worker_runs', 'SELECT'),
  'service_role no puede leer directamente tokens del ledger'
);
select ok(
  not has_table_privilege('service_role', 'public.expense_accounting_exports', 'SELECT,INSERT,UPDATE,DELETE'),
  'service_role opera el outbox únicamente mediante RPC fenced'
);
select ok(
  not has_table_privilege('service_role', 'public.expense_accounting_export_events', 'SELECT,INSERT,UPDATE,DELETE'),
  'service_role no altera directamente la bitácora contable'
);
select ok(
  not has_sequence_privilege('service_role', 'public.expense_accounting_export_events_id_seq', 'USAGE'),
  'service_role no usa directamente la secuencia de eventos'
);
select throws_ok(
  $$select * from public.start_expense_accounting_worker_run('INVALID')$$,
  '23514', 'Origen de ejecución contable inválido.', 'rechaza orígenes inventados'
);

set local role service_role;
create temporary table f4_run_one as
select * from public.start_expense_accounting_worker_run('CRON');
select ok((select acquired and run_id is not null and run_token is not null from f4_run_one), 'primer scheduler adquiere el run');
reset role;
select is((select status::text from public.expense_accounting_worker_runs), 'RUNNING', 'run comienza activo');
select is((select trigger_source from public.expense_accounting_worker_runs), 'CRON', 'origen queda auditado');

set local role service_role;
create temporary table f4_run_duplicate as
select * from public.start_expense_accounting_worker_run('AFTER_RESPONSE');
select ok((select not acquired and run_id is null and run_token is null from f4_run_duplicate), 'invocación concurrente no recibe token');
reset role;
select is((select count(*)::integer from public.expense_accounting_worker_runs), 1, 'no crea un segundo run concurrente');

set local role service_role;
select throws_ok(
  format(
    'select public.complete_expense_accounting_worker_run(%L,%L,true,0,0,0,0,null)',
    (select run_id from f4_run_one), gen_random_uuid()
  ),
  '23514', 'Token de ejecución contable inválido o ya cerrado.', 'token falso no puede cerrar el run'
);
select throws_ok(
  format(
    'select public.complete_expense_accounting_worker_run(%L,%L,true,2,1,0,0,null)',
    (select run_id from f4_run_one), (select run_token from f4_run_one)
  ),
  '23514', 'Una ejecución exitosa debe cerrar todos sus trabajos.', 'éxito parcial falla cerrado'
);
select lives_ok(
  format(
    'select public.complete_expense_accounting_worker_run(%L,%L,true,2,1,1,0,null)',
    (select run_id from f4_run_one), (select run_token from f4_run_one)
  ),
  'cierra un catch-up exitoso'
);
reset role;
select is((select status::text from public.expense_accounting_worker_runs), 'SUCCEEDED', 'run queda terminal');
select is((select claimed_count from public.expense_accounting_worker_runs), 2, 'persiste total reclamado');
select is((select retried_count from public.expense_accounting_worker_runs), 1, 'persiste total reintentado');
select ok((select completed_at is not null from public.expense_accounting_worker_runs), 'persiste heartbeat final');

set local role service_role;
create temporary table f4_health_fresh as
select * from public.get_expense_accounting_worker_health(93600);
reset role;
select is((select queued_count::integer from f4_health_fresh), 0, 'watchdog cuenta cola vacía');
select is((select last_run_status::text from f4_health_fresh), 'SUCCEEDED', 'watchdog ve el último run exitoso');
select ok((select not scheduler_stale from f4_health_fresh), 'éxito reciente mantiene scheduler sano');

set local role service_role;
create temporary table f4_run_stale as
select * from public.start_expense_accounting_worker_run('MANUAL');
reset role;
update public.expense_accounting_worker_runs
set started_at = clock_timestamp() - interval '11 minutes'
where id = (select run_id from f4_run_stale);
set local role service_role;
create temporary table f4_run_recovered as
select * from public.start_expense_accounting_worker_run('CRON');
select ok((select acquired from f4_run_recovered), 'un run abandonado no bloquea el scheduler');
reset role;
select is(
  (select count(*)::integer from public.expense_accounting_worker_runs where error_code = 'WORKER_ABANDONED'),
  1,
  'recuperación deja evidencia estable'
);
set local role service_role;
select lives_ok(
  format(
    'select public.complete_expense_accounting_worker_run(%L,%L,false,1,0,0,0,%L)',
    (select run_id from f4_run_recovered), (select run_token from f4_run_recovered), 'WORKER_EXECUTION_FAILED'
  ),
  'registra una ejecución fallida sin filtrar mensajes internos'
);
reset role;
select is(
  (select status::text from public.expense_accounting_worker_runs where id = (select run_id from f4_run_recovered)),
  'FAILED', 'fallo queda terminal'
);
set local role service_role;
select throws_ok(
  $$select * from public.get_expense_accounting_worker_health(3599)$$,
  '23514', 'Umbral de watchdog inválido.', 'watchdog rechaza umbral inseguro'
);
reset role;

select * from finish();
rollback;
