-- pgTAP GESTORA: contrato de serialización del organigrama por empresa.
create extension if not exists pgtap;

begin;
select plan(12);

select has_function(
  'public', 'prevent_reporting_line_cycle', array[]::text[],
  'existe la guardia transaccional del organigrama'
);

select has_table(
  'private', 'reporting_line_company_locks',
  'existe la fila interna de serialización por empresa'
);

select has_column(
  'private', 'reporting_line_company_locks', 'revision',
  'el lock interno conserva una revisión para forzar conflicto MVCC'
);

select ok(
  (
    select c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'private'
      and c.relname = 'reporting_line_company_locks'
  ),
  'la tabla interna permanece con RLS aunque no esté expuesta'
);

select ok(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'prevent_reporting_line_cycle'
      and p.pronargs = 0
  )
  and pg_catalog.strpos(
    pg_get_functiondef('public.prevent_reporting_line_cycle()'::regprocedure),
    'private.reporting_line_company_locks'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef('public.prevent_reporting_line_cycle()'::regprocedure),
    'on conflict (company_id) do update'
  ) > 0,
  'la guardia SECURITY DEFINER actualiza el lock privado antes de revalidar'
);

select ok(
  pg_catalog.strpos(
    pg_get_functiondef('public.prevent_reporting_line_cycle()'::regprocedure),
    'pg_advisory_xact_lock'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef('public.prevent_reporting_line_cycle()'::regprocedure),
    'gestora:reporting-lines'
  ) > 0,
  'la guardia usa un advisory lock transaccional con namespace propio'
);

select ok(
  pg_catalog.strpos(
    pg_get_functiondef('public.prevent_reporting_line_cycle()'::regprocedure),
    'old.company_id < new.company_id'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef('public.prevent_reporting_line_cycle()'::regprocedure),
    'v_second_company_id := new.company_id'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef('public.prevent_reporting_line_cycle()'::regprocedure),
    'v_second_company_id := old.company_id'
  ) > 0,
  'los cambios de empresa bloquean OLD y NEW en orden determinista'
);

select ok(
  pg_catalog.strpos(
    pg_get_functiondef('public.prevent_reporting_line_cycle()'::regprocedure),
    'pg_advisory_xact_lock'
  ) < pg_catalog.strpos(
    pg_get_functiondef('public.prevent_reporting_line_cycle()'::regprocedure),
    'if not new.is_primary'
  ),
  'el lock se adquiere antes de retornar una línea secundaria'
);

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name
) values
  ('f2110000-0000-0000-0000-000000000101', '0a4c0000-0000-0000-0000-000000000001', 'ORG-LOCK-101', 'Eva', 'Uno', 'Eva Uno'),
  ('f2110000-0000-0000-0000-000000000102', '0a4c0000-0000-0000-0000-000000000001', 'ORG-LOCK-102', 'Fabio', 'Dos', 'Fabio Dos');

select lives_ok(
  $$insert into public.reporting_lines (
      company_id, employee_id, manager_employee_id, effective_from, effective_to
    ) values (
      '0a4c0000-0000-0000-0000-000000000001',
      'f2110000-0000-0000-0000-000000000101',
      'f2110000-0000-0000-0000-000000000102',
      '2026-01-01', '2026-12-31'
    )$$,
  'se conserva una línea principal válida'
);

select lives_ok(
  $$insert into public.reporting_lines (
      company_id, employee_id, manager_employee_id, effective_from, effective_to, is_primary
    ) values (
      '0a4c0000-0000-0000-0000-000000000001',
      'f2110000-0000-0000-0000-000000000102',
      'f2110000-0000-0000-0000-000000000101',
      '2026-01-01', '2026-12-31', false
    )$$,
  'una arista inversa secundaria sigue permitida'
);

select throws_ok(
  $$update public.reporting_lines
      set is_primary = true
    where company_id = '0a4c0000-0000-0000-0000-000000000001'
      and employee_id = 'f2110000-0000-0000-0000-000000000102'
      and manager_employee_id = 'f2110000-0000-0000-0000-000000000101'$$,
  '23514', 'La línea de reporte formaría un ciclo en el organigrama.',
  'convertir una línea secundaria a principal conserva el rechazo de ciclos'
);

select is(
  (
    select count(*)::integer
    from public.reporting_lines
    where company_id = '0a4c0000-0000-0000-0000-000000000001'
      and employee_id in (
        'f2110000-0000-0000-0000-000000000101',
        'f2110000-0000-0000-0000-000000000102'
      )
      and is_primary
  ),
  1,
  'el intento rechazado no deja un ciclo principal persistido'
);

select * from finish();
rollback;
