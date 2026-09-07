-- pgTAP: una marcación histórica de ARCOTEX debe extender la única
-- asignación de grupo creada desde el caché, sin exponer el helper a la API.
create extension if not exists pgtap;

begin;
select plan(9);

select has_function(
  'private',
  'extend_arcotex_initial_group_history',
  array['uuid', 'date'],
  'existe el helper acotado que extiende el tramo inicial'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'private.extend_arcotex_initial_group_history(uuid,date)',
    'EXECUTE'
  ),
  'el navegador no puede extender historial de grupo'
);

select ok(
  not has_function_privilege(
    'service_role',
    'private.extend_arcotex_initial_group_history(uuid,date)',
    'EXECUTE'
  ),
  'la clave de servicio tampoco puede invocar el helper directamente'
);

select has_trigger(
  'public',
  'workera_attendance_events',
  'workera_attendance_extend_arcotex_initial_group',
  'la ingesta de marcaciones instala la extensión histórica'
);

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id
) values (
  'a7100000-0000-4000-8000-000000000201',
  '0a4c0000-0000-0000-0000-000000000001',
  'TEST-GROUP-HISTORY-111', 'Grupo', 'Histórico', 'Grupo Histórico',
  (
    select eg.id from public.employee_groups eg
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and eg.code = 'PRODUCTION'
  )
);

select is(
  (
    select ega.effective_from
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000201'
  ),
  current_date,
  'sin hechos previos el tramo interno comienza hoy'
);

insert into public.sync_runs (
  id, company_id, status, target_period_start, target_period_end,
  triggered_by, records_read, records_created, records_updated,
  records_unchanged
) values (
  'a7100000-0000-4000-8000-000000000301',
  '0a4c0000-0000-0000-0000-000000000001',
  'SUCCEEDED', current_date - 14, current_date - 14,
  'MANUAL', 1, 1, 0, 0
);

insert into public.workera_attendance_events (
  id, company_id, employee_id, external_employee_code,
  attendance_timestamp_raw, attendance_type_code, attendance_type_label,
  attendance_status, external_attendance_status, source_version, sync_run_id
) values (
  'a7100000-0000-4000-8000-000000000401',
  '0a4c0000-0000-0000-0000-000000000001',
  'a7100000-0000-4000-8000-000000000201',
  'TEST-GROUP-HISTORY-111',
  pg_catalog.to_char(current_date - 14, 'YYYY-MM-DD') || 'T08:00:00',
  0, 'ENTRADA', 'ACTIVO', 'Activo', 1,
  'a7100000-0000-4000-8000-000000000301'
);

select is(
  (
    select ega.effective_from
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000201'
  ),
  current_date - 14,
  'la marcación extiende la asignación inicial hasta su fecha'
);

select is(
  (
    select ega.source
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000201'
  ),
  'internal',
  'la extensión conserva el origen del tramo'
);

select is(
  (
    select eg.code
    from public.employee_group_assignments ega
    join public.employee_groups eg on eg.id = ega.employee_group_id
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000201'
  ),
  'PRODUCTION',
  'la extensión no cambia la clasificación de grupo'
);

select is(
  (
    select pg_catalog.count(*)::integer
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000201'
  ),
  1,
  'la corrección no inventa tramos adicionales'
);

select * from finish();
rollback;
