-- pgTAP P0-A: evidencia mínima y no sensible de la purga del asistente.
create extension if not exists pgtap;

begin;
select plan(12);

select has_function(
  'public', 'purge_expired_expense_assistant_queries', array[]::text[],
  'la purga auditada conserva su contrato'
);
select ok(
  has_function_privilege('service_role', 'public.purge_expired_expense_assistant_queries()', 'EXECUTE'),
  'service_role puede ejecutar la retención'
);
select ok(
  not has_function_privilege('authenticated', 'public.purge_expired_expense_assistant_queries()', 'EXECUTE'),
  'authenticated no puede ejecutar la retención'
);
select ok(
  not has_function_privilege('anon', 'public.purge_expired_expense_assistant_queries()', 'EXECUTE'),
  'anon no puede ejecutar la retención'
);
select matches(
  pg_get_functiondef('public.purge_expired_expense_assistant_queries()'::regprocedure),
  'insert into public[.]audit_log',
  'el RPC escribe el ledger en la misma transacción que la purga'
);

set local role service_role;
select is(
  public.purge_expired_expense_assistant_queries(), 0,
  'una ejecución sin filas vencidas sigue siendo observable'
);
reset role;

select is(
  (select count(*)::integer from public.audit_log
   where action = 'EXPENSE_ASSISTANT_RETENTION_SUCCEEDED'),
  1,
  'la ejecución genera exactamente un evento'
);
select is(
  (select actor_id from public.audit_log
   where action = 'EXPENSE_ASSISTANT_RETENTION_SUCCEEDED'),
  null::uuid,
  'el evento se atribuye al sistema y no inventa un actor'
);
select is(
  (select entity_type from public.audit_log
   where action = 'EXPENSE_ASSISTANT_RETENTION_SUCCEEDED'),
  'expense_assistant_retention_runs',
  'el evento usa un tipo de entidad operativo explícito'
);
select is(
  (select metadata ->> 'result' from public.audit_log
   where action = 'EXPENSE_ASSISTANT_RETENTION_SUCCEEDED'),
  'SUCCEEDED',
  'el resultado es explícito'
);
select is(
  (select (metadata ->> 'deleted_count')::integer from public.audit_log
   where action = 'EXPENSE_ASSISTANT_RETENTION_SUCCEEDED'),
  0,
  'el ledger conserva solo el conteo eliminado'
);
select is(
  (select metadata - array['result', 'deleted_count', 'retention_days']
   from public.audit_log
   where action = 'EXPENSE_ASSISTANT_RETENTION_SUCCEEDED'),
  '{}'::jsonb,
  'el metadata no contiene consultas, actores, empresas ni identificadores'
);

select * from finish();
rollback;
