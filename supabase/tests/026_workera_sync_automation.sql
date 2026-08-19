-- pgTAP Fase 6B: infraestructura de automatización de la ingesta Workera --
-- extensión de sync_runs (triggered_by/attempt/retry_of/error_category),
-- concurrencia real vía índice único parcial, y reclamo de locks huérfanos.
create extension if not exists pgtap;

begin;
select plan(24);

-- ---------------------------------------------------------------------------
-- 1) Columnas nuevas existen con los defaults documentados.
select has_column('public', 'sync_runs', 'triggered_by', 'sync_runs tiene triggered_by');
select has_column('public', 'sync_runs', 'attempt', 'sync_runs tiene attempt');
select has_column('public', 'sync_runs', 'retry_of', 'sync_runs tiene retry_of');
select has_column('public', 'sync_runs', 'error_category', 'sync_runs tiene error_category');

-- ---------------------------------------------------------------------------
-- 2) Defaults compatibles con las filas de Fase 6A (triggered_by='MANUAL', attempt=1).
insert into public.sync_runs (status, target_period_start, target_period_end)
values ('SUCCEEDED', '2026-08-01', '2026-08-01');

select is(
  (select triggered_by from public.sync_runs where target_period_start = '2026-08-01'),
  'MANUAL',
  'triggered_by default MANUAL preserva la semántica de las filas de Fase 6A'
);
select is(
  (select attempt from public.sync_runs where target_period_start = '2026-08-01'),
  1,
  'attempt default 1'
);

-- ---------------------------------------------------------------------------
-- 3) Check constraints rechazan valores inválidos.
select throws_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end, triggered_by)
     values ('RUNNING', '2026-08-02', '2026-08-02', 'WEBHOOK') $$,
  '23514',
  null,
  'triggered_by solo admite CRON/MANUAL'
);

select throws_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end, attempt)
     values ('RUNNING', '2026-08-03', '2026-08-03', 0) $$,
  '23514',
  null,
  'attempt debe ser >= 1'
);

select throws_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end, error_category)
     values ('FAILED', '2026-08-04', '2026-08-04', 'ALIEN_INVASION') $$,
  '23514',
  null,
  'error_category solo admite las categorías estables documentadas'
);

select lives_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end, error_category)
     values ('FAILED', '2026-08-05', '2026-08-05', 'WORKERA_TIMEOUT') $$,
  'error_category acepta una categoría válida de la lista documentada'
);

-- ---------------------------------------------------------------------------
-- 4) retry_of enlaza con un intento anterior real.
insert into public.sync_runs (id, status, target_period_start, target_period_end, attempt)
values ('93000000-0000-0000-0000-000000000001', 'FAILED', '2026-08-06', '2026-08-06', 1);

select lives_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end, attempt, retry_of)
     values ('SUCCEEDED', '2026-08-06', '2026-08-06', 2, '93000000-0000-0000-0000-000000000001') $$,
  'retry_of enlaza correctamente con sync_runs.id de un intento anterior real'
);

select throws_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end, retry_of)
     values ('RUNNING', '2026-08-07', '2026-08-07', '93000000-0000-0000-0000-00000000dead') $$,
  '23503',
  null,
  'retry_of exige un sync_runs.id existente (FK real, no un uuid suelto)'
);

-- ---------------------------------------------------------------------------
-- 5) Concurrencia real: a lo sumo un RUNNING por rango exacto -- ES el
--    mecanismo de lock de Fase 6B (índice único parcial), no una tabla
--    separada.
insert into public.sync_runs (status, target_period_start, target_period_end)
values ('RUNNING', '2026-08-19', '2026-08-19');

select throws_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end)
     values ('RUNNING', '2026-08-19', '2026-08-19') $$,
  '23505',
  null,
  'un segundo INSERT RUNNING para el MISMO rango es rechazado (sync_runs_no_concurrent_running_key)'
);

select lives_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end)
     values ('RUNNING', '2026-08-20', '2026-08-20') $$,
  'un RUNNING para un rango DISTINTO no se ve afectado -- concurrencia por rango, no global'
);

update public.sync_runs set status = 'SUCCEEDED', finished_at = now()
  where target_period_start = '2026-08-19' and status = 'RUNNING';

select lives_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end)
     values ('RUNNING', '2026-08-19', '2026-08-19') $$,
  'tras terminar (SUCCEEDED) el RUNNING anterior, el mismo rango vuelve a aceptar un RUNNING nuevo'
);

update public.sync_runs set status = 'SUCCEEDED', finished_at = now()
  where target_period_start in ('2026-08-19', '2026-08-20') and status = 'RUNNING';

-- ---------------------------------------------------------------------------
-- 6) reclaim_stale_workera_sync_runs -- recuperación de locks huérfanos.
insert into public.sync_runs (id, status, target_period_start, target_period_end, started_at)
values ('93000000-0000-0000-0000-000000000002', 'RUNNING', '2026-08-21', '2026-08-21', now() - interval '20 minutes');

insert into public.sync_runs (id, status, target_period_start, target_period_end, started_at)
values ('93000000-0000-0000-0000-000000000003', 'RUNNING', '2026-08-22', '2026-08-22', now());

select is(
  (select public.reclaim_stale_workera_sync_runs(900)),
  1,
  'reclaim_stale_workera_sync_runs reclama exactamente el RUNNING viejo (>900s), no el reciente'
);

select is(
  (select status from public.sync_runs where id = '93000000-0000-0000-0000-000000000002'),
  'FAILED',
  'el sync_run viejo reclamado queda FAILED'
);
select is(
  (select error_category from public.sync_runs where id = '93000000-0000-0000-0000-000000000002'),
  'CONCURRENCY',
  'el sync_run reclamado se categoriza como CONCURRENCY'
);
select is(
  (select status from public.sync_runs where id = '93000000-0000-0000-0000-000000000003'),
  'RUNNING',
  'el sync_run reciente NO se reclama -- sigue RUNNING'
);

-- Tras el reclamo, el rango liberado vuelve a aceptar un RUNNING nuevo.
select lives_ok(
  $$ insert into public.sync_runs (status, target_period_start, target_period_end)
     values ('RUNNING', '2026-08-21', '2026-08-21') $$,
  'tras reclamar un RUNNING huérfano, su rango vuelve a aceptar un intento nuevo'
);

update public.sync_runs set status = 'SUCCEEDED', finished_at = now()
  where target_period_start in ('2026-08-21', '2026-08-22') and status = 'RUNNING';

-- ---------------------------------------------------------------------------
-- 7) Grants: reclaim_stale_workera_sync_runs solo ejecutable por service_role.
select ok(
  not has_function_privilege('authenticated', 'public.reclaim_stale_workera_sync_runs(integer)', 'EXECUTE'),
  'authenticated NO puede ejecutar reclaim_stale_workera_sync_runs'
);
select ok(
  not has_function_privilege('anon', 'public.reclaim_stale_workera_sync_runs(integer)', 'EXECUTE'),
  'anon NO puede ejecutar reclaim_stale_workera_sync_runs'
);
select ok(
  has_function_privilege('service_role', 'public.reclaim_stale_workera_sync_runs(integer)', 'EXECUTE'),
  'service_role SÍ puede ejecutar reclaim_stale_workera_sync_runs'
);

-- ---------------------------------------------------------------------------
-- 8) Lectura de sync_runs sigue restringida a administradores privilegiados
--    (política heredada de Fase 2A/5D, no debe romperse por las columnas nuevas).
insert into public.profiles (id, display_name, role) values
  ('93000000-0000-0000-0000-000000000010', 'Fixture 6B Supervisor', 'SUPERVISOR_PRODUCTION');

set local role authenticated;
set local request.jwt.claim.sub = '93000000-0000-0000-0000-000000000010';

select is(
  (select count(*)::int from public.sync_runs),
  0,
  'SUPERVISOR_PRODUCTION sigue sin poder leer ninguna fila de sync_runs (RLS-filtrado) -- las columnas nuevas no relajaron la RLS existente'
);

select * from finish();
rollback;
