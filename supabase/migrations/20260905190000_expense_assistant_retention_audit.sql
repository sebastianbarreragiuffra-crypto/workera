-- P0-A: la purga de retención del asistente debe dejar evidencia durable.
-- El evento contiene solo conteo, ventana y resultado; nunca consultas,
-- respuestas, actores, empresas ni identificadores de las filas eliminadas.

create or replace function public.purge_expired_expense_assistant_queries()
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
  v_run_id uuid := gen_random_uuid();
begin
  delete from public.expense_assistant_queries q
  where q.created_at < pg_catalog.statement_timestamp() - interval '90 days';
  get diagnostics v_deleted = row_count;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, metadata)
  values (
    null,
    'EXPENSE_ASSISTANT_RETENTION_SUCCEEDED',
    'expense_assistant_retention_runs',
    v_run_id,
    pg_catalog.jsonb_build_object(
      'result', 'SUCCEEDED',
      'deleted_count', v_deleted,
      'retention_days', 90
    )
  );

  return v_deleted;
end;
$$;

revoke all on function public.purge_expired_expense_assistant_queries()
  from public, anon, authenticated;
grant execute on function public.purge_expired_expense_assistant_queries()
  to service_role;

comment on function public.purge_expired_expense_assistant_queries() is
  'Purga global de respuestas mayores a 90 días y registra un evento agregado sin PII. Solo service_role.';
