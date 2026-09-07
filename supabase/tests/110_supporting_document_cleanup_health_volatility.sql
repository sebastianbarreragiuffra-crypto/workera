-- pgTAP: la salud operacional debe consultar el reloj y el backlog actuales.
create extension if not exists pgtap;

begin;
select plan(3);

select volatility_is(
  'public',
  'get_supporting_document_cleanup_health',
  array['integer'],
  'volatile',
  'el snapshot de salud no se reutiliza como si fuera estable'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.get_supporting_document_cleanup_health(integer)',
    'EXECUTE'
  ),
  'el watchdog conserva acceso al snapshot'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_supporting_document_cleanup_health(integer)',
    'EXECUTE'
  ),
  'la correccion no expone el backlog global al navegador'
);

select * from finish();
rollback;
