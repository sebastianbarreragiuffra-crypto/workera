-- pgTAP: los roles expuestos por la API nunca reciben TRUNCATE ni otros
-- privilegios estructurales sobre relaciones de negocio. También prueba el
-- default para que una tabla futura no vuelva a heredar el problema.
create extension if not exists pgtap;

begin;
select plan(5);

-- Relaciones creadas después del lockdown original, incluidas las dos vistas
-- que todavía conservaban privilegios por defecto y las tablas MT-1/MT-2.
create temporary table expected_grants (
  table_name text primary key,
  privileges text[] not null
);

insert into expected_grants (table_name, privileges) values
  ('attendance_effective_punches', array['SELECT']),
  ('supporting_documents', array['SELECT', 'UPDATE']),
  ('supporting_documents_metadata', array['SELECT']),
  ('employee_time_control_policies', array['DELETE', 'INSERT', 'SELECT', 'UPDATE']),
  ('early_departure_records', array['SELECT']),
  ('early_departure_decisions', array['INSERT', 'SELECT', 'UPDATE']),
  ('employee_birthdays', array['DELETE', 'INSERT', 'SELECT', 'UPDATE']),
  ('suppliers', array['DELETE', 'INSERT', 'SELECT', 'UPDATE']),
  ('payroll_batches', array['INSERT', 'SELECT']),
  ('payroll_batch_items', array['INSERT', 'SELECT']),
  ('supplier_master_imports', array['INSERT', 'SELECT', 'UPDATE']),
  ('medical_license_approvals', array['SELECT', 'UPDATE']),
  ('colaciones_discount_workbooks', array['INSERT', 'SELECT', 'UPDATE']),
  ('companies', array['SELECT']),
  ('company_memberships', array['SELECT']);

select is(
  (
    select count(*)::integer
    from information_schema.role_table_grants g
    join expected_grants e using (table_name)
    where g.table_schema = 'public'
      and g.grantee in ('anon', 'authenticated')
      and g.privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  ),
  0,
  'anon/authenticated no conservan TRUNCATE, REFERENCES ni TRIGGER'
);

select is(
  (
    select count(*)::integer
    from information_schema.role_table_grants g
    join expected_grants e using (table_name)
    where g.table_schema = 'public' and g.grantee = 'anon'
  ),
  0,
  'anon no conserva ningún privilegio sobre las relaciones protegidas'
);

select is(
  (
    with actual as (
      select
        g.table_name,
        array_agg(g.privilege_type::text order by g.privilege_type) as privileges
      from information_schema.role_table_grants g
      join expected_grants e using (table_name)
      where g.table_schema = 'public' and g.grantee = 'authenticated'
      group by g.table_name
    )
    select count(*)::integer
    from expected_grants e
    left join actual a using (table_name)
    where a.privileges is distinct from e.privileges
  ),
  0,
  'authenticated conserva exactamente los permisos DML mínimos esperados'
);

-- Prueba el ALTER DEFAULT PRIVILEGES dentro de la misma transacción. Si una
-- migración futura crea una tabla y olvida su GRANT explícito, queda cerrada.
create table public._grant_lockdown_probe (id integer);

select ok(
  not has_table_privilege('anon', 'public._grant_lockdown_probe', 'SELECT')
  and not has_table_privilege('anon', 'public._grant_lockdown_probe', 'TRUNCATE'),
  'una tabla futura no otorga privilegios por defecto a anon'
);

select ok(
  not has_table_privilege('authenticated', 'public._grant_lockdown_probe', 'SELECT')
  and not has_table_privilege('authenticated', 'public._grant_lockdown_probe', 'TRUNCATE'),
  'una tabla futura exige GRANT explícito para authenticated'
);

select * from finish();
rollback;
