begin;
select plan(4);

select lives_ok(
  $$
    insert into public.employees (
      company_id, external_workera_id, first_name, last_name, display_name, source
    ) values (
      '0a4c0000-0000-0000-0000-000000000001',
      'LOCAL-PROVISIONAL:PGTAP-IDENTITY',
      'PERSONA', 'PROVISIONAL', 'PERSONA PROVISIONAL', 'local_provisional'
    )
  $$,
  'local_provisional identifica una persona real pendiente de código oficial'
);

select throws_ok(
  $$
    insert into public.employees (
      company_id, external_workera_id, first_name, last_name, display_name, source
    ) values (
      '0a4c0000-0000-0000-0000-000000000001',
      'FUENTE-INVALIDA:PGTAP',
      'PERSONA', 'INVALIDA', 'PERSONA INVALIDA', 'invented_source'
    )
  $$,
  '23514',
  null,
  'una procedencia inventada sigue siendo rechazada'
);

select throws_ok(
  $$
    insert into public.employees (
      company_id, external_workera_id, first_name, last_name, display_name, source
    ) values (
      '0a4c0000-0000-0000-0000-000000000001',
      '12345678',
      'PERSONA', 'PROVISIONAL', 'PERSONA PROVISIONAL', 'local_provisional'
    )
  $$,
  '23514',
  null,
  'local_provisional exige el prefijo técnico reservado'
);

select throws_ok(
  $$
    insert into public.employees (
      company_id, external_workera_id, first_name, last_name, display_name, source
    ) values (
      '0a4c0000-0000-0000-0000-000000000001',
      'LOCAL-PROVISIONAL:NO-ES-WORKERA',
      'PERSONA', 'WORKERA', 'PERSONA WORKERA', 'workera'
    )
  $$,
  '23514',
  null,
  'una clave provisional nunca se acepta como código Workera real'
);

select * from finish();
rollback;
