-- pgTAP: una marcación histórica de ARCOTEX debe extender la única
-- asignación de grupo creada desde el caché, sin exponer el helper a la API.
create extension if not exists pgtap;

begin;
select plan(16);

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

-- Una segunda marcación del mismo día vuelve a ejecutar el trigger, pero no
-- debe mover ni duplicar el tramo ya corregido.
insert into public.workera_attendance_events (
  id, company_id, employee_id, external_employee_code,
  attendance_timestamp_raw, attendance_type_code, attendance_type_label,
  attendance_status, external_attendance_status, source_version, sync_run_id
) values (
  'a7100000-0000-4000-8000-000000000402',
  '0a4c0000-0000-0000-0000-000000000001',
  'a7100000-0000-4000-8000-000000000201',
  'TEST-GROUP-HISTORY-111',
  pg_catalog.to_char(current_date - 14, 'YYYY-MM-DD') || 'T17:00:00',
  1, 'SALIDA', 'ACTIVO', 'Activo', 1,
  'a7100000-0000-4000-8000-000000000301'
);

select is(
  (
    select ega.effective_from
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000201'
  ),
  current_date - 14,
  'reprocesar otra marcación del mismo día es idempotente'
);

-- El mismo patrón en otro tenant nunca puede modificar su historial.
insert into public.companies (id, name, slug, active) values (
  'b7100000-0000-4000-8000-000000000001',
  'OTRO TENANT 111',
  'otro-tenant-111',
  true
);

-- MT-3A impide crear hoy datos laborales para otro tenant. Se suspenden solo
-- sus dos guards durante el fixture para representar una fila histórica
-- preexistente; la transacción de pgTAP revierte también estos ALTER TABLE.
alter table public.employee_groups
  disable trigger employee_groups_require_enabled_workspace;
insert into public.employee_groups (id, company_id, code, name) values (
  'b7100000-0000-4000-8000-000000000101',
  'b7100000-0000-4000-8000-000000000001',
  'TEST_OTHER_111',
  'Otro grupo 111'
);
alter table public.employee_groups
  enable trigger employee_groups_require_enabled_workspace;

alter table public.employees
  disable trigger employees_require_enabled_workspace;
insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id
) values (
  'b7100000-0000-4000-8000-000000000201',
  'b7100000-0000-4000-8000-000000000001',
  'TEST-OTHER-TENANT-111', 'Otro', 'Tenant', 'Otro Tenant',
  'b7100000-0000-4000-8000-000000000101'
);
alter table public.employees
  enable trigger employees_require_enabled_workspace;

insert into public.sync_runs (
  id, company_id, status, target_period_start, target_period_end,
  triggered_by, records_read, records_created, records_updated,
  records_unchanged
) values (
  'b7100000-0000-4000-8000-000000000301',
  'b7100000-0000-4000-8000-000000000001',
  'SUCCEEDED', current_date - 14, current_date - 14,
  'MANUAL', 1, 1, 0, 0
);

insert into public.workera_attendance_events (
  id, company_id, employee_id, external_employee_code,
  attendance_timestamp_raw, attendance_type_code, attendance_type_label,
  attendance_status, external_attendance_status, source_version, sync_run_id
) values (
  'b7100000-0000-4000-8000-000000000401',
  'b7100000-0000-4000-8000-000000000001',
  'b7100000-0000-4000-8000-000000000201',
  'TEST-OTHER-TENANT-111',
  pg_catalog.to_char(current_date - 14, 'YYYY-MM-DD') || 'T08:00:00',
  0, 'ENTRADA', 'ACTIVO', 'Activo', 1,
  'b7100000-0000-4000-8000-000000000301'
);

select is(
  (
    select ega.effective_from
    from public.employee_group_assignments ega
    where ega.employee_id = 'b7100000-0000-4000-8000-000000000201'
  ),
  current_date,
  'una marcación de otro tenant no extiende historial'
);

-- Prepara cuatro fichas ARCOTEX para probar cada guardia negativa de forma
-- independiente: historia real, origen Workera, sync_run y versión retirada.
insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  employee_group_id
) values
  (
    'a7100000-0000-4000-8000-000000000202',
    '0a4c0000-0000-0000-0000-000000000001',
    'TEST-MULTI-HISTORY-111', 'Historia', 'Real', 'Historia Real',
    (select eg.id from public.employee_groups eg
      where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
        and eg.code = 'PRODUCTION')
  ),
  (
    'a7100000-0000-4000-8000-000000000203',
    '0a4c0000-0000-0000-0000-000000000001',
    'TEST-WORKERA-SOURCE-111', 'Origen', 'Workera', 'Origen Workera',
    (select eg.id from public.employee_groups eg
      where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
        and eg.code = 'PRODUCTION')
  ),
  (
    'a7100000-0000-4000-8000-000000000204',
    '0a4c0000-0000-0000-0000-000000000001',
    'TEST-SYNC-LINKED-111', 'Con', 'Sync', 'Con Sync',
    (select eg.id from public.employee_groups eg
      where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
        and eg.code = 'PRODUCTION')
  ),
  (
    'a7100000-0000-4000-8000-000000000205',
    '0a4c0000-0000-0000-0000-000000000001',
    'TEST-SUPERSEDED-111', 'Evento', 'Retirado', 'Evento Retirado',
    (select eg.id from public.employee_groups eg
      where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
        and eg.code = 'PRODUCTION')
  );

-- Convierte la fila sintética del primer trabajador en dos tramos reales. El
-- evento anterior a ambos no debe hacer inferencias sobre esa historia.
update public.employee_group_assignments
set effective_from = current_date - 10,
    effective_to = current_date - 1
where employee_id = 'a7100000-0000-4000-8000-000000000202';

insert into public.employee_group_assignments (
  employee_id, employee_group_id, effective_from, source
) values (
  'a7100000-0000-4000-8000-000000000202',
  (select eg.id from public.employee_groups eg
    where eg.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and eg.code = 'PRODUCTION'),
  current_date,
  'internal'
);

update public.employee_group_assignments
set source = 'workera'
where employee_id = 'a7100000-0000-4000-8000-000000000203';

update public.employee_group_assignments
set sync_run_id = 'a7100000-0000-4000-8000-000000000301'
where employee_id = 'a7100000-0000-4000-8000-000000000204';

insert into public.workera_attendance_events (
  id, company_id, employee_id, external_employee_code,
  attendance_timestamp_raw, attendance_type_code, attendance_type_label,
  attendance_status, external_attendance_status, source_version, is_current,
  sync_run_id
) values
  (
    'a7100000-0000-4000-8000-000000000421',
    '0a4c0000-0000-0000-0000-000000000001',
    'a7100000-0000-4000-8000-000000000202',
    'TEST-MULTI-HISTORY-111',
    pg_catalog.to_char(current_date - 14, 'YYYY-MM-DD') || 'T08:00:00',
    0, 'ENTRADA', 'ACTIVO', 'Activo', 1, true,
    'a7100000-0000-4000-8000-000000000301'
  ),
  (
    'a7100000-0000-4000-8000-000000000431',
    '0a4c0000-0000-0000-0000-000000000001',
    'a7100000-0000-4000-8000-000000000203',
    'TEST-WORKERA-SOURCE-111',
    pg_catalog.to_char(current_date - 14, 'YYYY-MM-DD') || 'T08:00:00',
    0, 'ENTRADA', 'ACTIVO', 'Activo', 1, true,
    'a7100000-0000-4000-8000-000000000301'
  ),
  (
    'a7100000-0000-4000-8000-000000000441',
    '0a4c0000-0000-0000-0000-000000000001',
    'a7100000-0000-4000-8000-000000000204',
    'TEST-SYNC-LINKED-111',
    pg_catalog.to_char(current_date - 14, 'YYYY-MM-DD') || 'T08:00:00',
    0, 'ENTRADA', 'ACTIVO', 'Activo', 1, true,
    'a7100000-0000-4000-8000-000000000301'
  ),
  (
    'a7100000-0000-4000-8000-000000000451',
    '0a4c0000-0000-0000-0000-000000000001',
    'a7100000-0000-4000-8000-000000000205',
    'TEST-SUPERSEDED-111',
    pg_catalog.to_char(current_date - 14, 'YYYY-MM-DD') || 'T08:00:00',
    0, 'ENTRADA', 'ACTIVO', 'Activo', 1, false,
    'a7100000-0000-4000-8000-000000000301'
  );

select is(
  (
    select pg_catalog.count(*)::integer
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000202'
  ),
  2,
  'una historia con más de un tramo conserva todos sus tramos'
);

select is(
  (
    select pg_catalog.min(ega.effective_from)
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000202'
  ),
  current_date - 10,
  'una historia con más de un tramo no se retrotrae'
);

select is(
  (
    select ega.effective_from
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000203'
  ),
  current_date,
  'un tramo de origen Workera no se reescribe'
);

select is(
  (
    select ega.effective_from
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000204'
  ),
  current_date,
  'un tramo ligado a sync_run no se reescribe'
);

select is(
  (
    select ega.effective_from
    from public.employee_group_assignments ega
    where ega.employee_id = 'a7100000-0000-4000-8000-000000000205'
  ),
  current_date,
  'una versión de marcación retirada no extiende historial'
);

select * from finish();
rollback;
