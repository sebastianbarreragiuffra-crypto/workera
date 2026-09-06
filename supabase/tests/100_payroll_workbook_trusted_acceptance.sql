-- Ejecutar exclusivamente sobre una instancia aislada compatible con todas
-- las migraciones de esta rama. No usar la Supabase local compartida.
create extension if not exists pgtap;

begin;
select plan(18);

select has_table(
  'private',
  'payroll_workbook_acceptance_receipts',
  'existe el recibo privado de idempotencia'
);

select has_function(
  'public',
  'register_accepted_payroll_workbook',
  array[
    'uuid', 'uuid', 'date', 'date', 'uuid', 'text', 'integer', 'text',
    'text', 'jsonb', 'bigint', 'text', 'integer', 'text'
  ],
  'existe el commit confiable con actor y evidencia verificada'
);

select ok(
  (select p.prosecdef
   from pg_catalog.pg_proc p
   where p.oid = (
     'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'
   )::regprocedure),
  'el commit es SECURITY DEFINER'
);

select ok(
  (select p.provolatile = 'v'
   from pg_catalog.pg_proc p
   where p.oid = (
     'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'
   )::regprocedure),
  'el commit es VOLATILE'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated no ejecuta la implementación antigua de nueve argumentos'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb,bigint)',
    'EXECUTE'
  ),
  'authenticated no ejecuta el wrapper de revisión de diez argumentos'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb,bigint)',
    'EXECUTE'
  ),
  'service_role tampoco puede saltarse el overload verificador'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)',
    'EXECUTE'
  ),
  'authenticated no puede confirmar directamente'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)',
    'EXECUTE'
  ),
  'anon no puede confirmar'
);

select ok(
  not has_function_privilege(
    'service_role',
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)',
    'EXECUTE'
  )
  and has_function_privilege(
    'service_role',
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text,uuid,text,timestamp with time zone)',
    'EXECUTE'
  ),
  'solo service_role posee el commit con atestación física'
);

select ok(
  not has_function_privilege('authenticated', 'public.accept_payroll_workbook_version(uuid,uuid)', 'EXECUTE'),
  'el camino legacy UPLOADED -> ACCEPTED también queda clausurado'
);

select ok(
  not has_table_privilege(
    'authenticated',
    'private.payroll_workbook_acceptance_receipts',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'authenticated no observa ni altera recibos idempotentes'
);

select ok(
  not has_table_privilege(
    'service_role',
    'private.payroll_workbook_acceptance_receipts',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'service_role solo opera recibos mediante el SECURITY DEFINER'
);

select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%auth.role() is distinct from ''service_role''%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%p_verified_content_sha256 is distinct from p_content_sha256%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%p_verified_file_size is distinct from p_file_size%',
  'el RPC exige identidad de servicio y bytes verificados'
);

select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%join public.company_membership_roles cmr%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%join public.company_roles cr%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%cr.base_role = ''ADMIN_RRHH''%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%cm.company_id = p_company_id%',
  'actor, rol RRHH y membresía del tenant se revalidan dentro del RPC'
);

select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%payroll_workbook_acceptance_receipts%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%pg_advisory_xact_lock%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) like '%return v_receipt.version_id%',
  'lock y recibo hacen repetible el commit tras una respuesta ambigua'
);

select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,uuid,date,date,uuid,text,integer,text,text,jsonb,bigint,text,integer,text)'::regprocedure
  ) not like '%select * into v_existing%content_sha256 = p_content_sha256%',
  'el commit no recupera por hash ignorando actor, motivo o cambios'
);

select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) not like '%and content_sha256 = p_content_sha256%return%',
  'el wrapper interno tampoco confunde dos comandos distintos con bytes iguales'
);

select * from finish();
rollback;
