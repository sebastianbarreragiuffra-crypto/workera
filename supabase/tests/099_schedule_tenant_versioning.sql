-- Ejecutar solo en una instancia aislada compatible con todas las migraciones
-- de esta rama. La instancia local compartida no debe reiniciarse ni mutarse.
create extension if not exists pgtap;

begin;
select plan(39);

select has_column('public', 'work_schedules', 'company_id',
  'cada definición de horario pertenece a una empresa');
select has_column('public', 'work_schedule_rules', 'company_id',
  'cada regla conserva la empresa de su definición');
select has_column('public', 'schedule_assignments', 'company_id',
  'cada asignación conserva la empresa del trabajador');
select has_column('public', 'work_schedules', 'supersedes_schedule_id',
  'una versión nueva enlaza la definición anterior');
select has_column('public', 'work_schedules', 'definition_version',
  'la definición expone un número de versión auditable');

select ok(
  exists (select 1 from pg_constraint where conname = 'work_schedules_company_id_id_key'),
  'work_schedules ofrece una clave compuesta tenant-aware'
);
select ok(
  exists (select 1 from pg_constraint where conname = 'work_schedule_rules_company_schedule_fkey'),
  'una regla solo puede apuntar a una definición de la misma empresa'
);
select ok(
  exists (select 1 from pg_constraint where conname = 'schedule_assignments_company_schedule_fkey'),
  'una asignación solo puede apuntar a una definición de la misma empresa'
);
select is_empty(
  $$ select 1
     from public.work_schedule_rules r
     join public.work_schedules s on s.id = r.work_schedule_id
     where r.company_id <> s.company_id $$,
  'la migración no deja reglas vinculadas a otra empresa'
);
select is_empty(
  $$ select 1
     from public.schedule_assignments a
     join public.work_schedules s on s.id = a.work_schedule_id
     where a.company_id <> s.company_id $$,
  'las asignaciones globales preexistentes fueron clonadas y repuntadas por tenant'
);

select has_trigger('public', 'work_schedules', 'work_schedules_20_protect_assigned',
  'las definiciones usadas están protegidas contra mutación y borrado');
select has_trigger('public', 'work_schedule_rules', 'work_schedule_rules_20_protect_assigned',
  'las reglas usadas están protegidas contra mutación y borrado');
select has_trigger('public', 'schedule_assignments', 'schedule_assignments_10_stamp_company',
  'la empresa de una asignación se deriva server-side');

select ok(
  (select qual::text like '%has_company_permission(company_id%attendance.read%'
   from pg_policies
   where schemaname = 'public' and tablename = 'work_schedules'
     and policyname = 'work_schedules_select'),
  'la lectura de definiciones queda aislada por membresía de empresa'
);
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'work_schedules'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
  and not has_table_privilege('authenticated', 'public.work_schedules', 'INSERT')
  and not has_table_privilege('authenticated', 'public.work_schedules', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.work_schedules', 'DELETE')
  and not has_table_privilege('service_role', 'public.work_schedules', 'INSERT')
  and not has_table_privilege('service_role', 'public.work_schedules', 'UPDATE')
  and not has_table_privilege('service_role', 'public.work_schedules', 'DELETE'),
  'las definiciones no admiten DML directo que omita el RPC y MFA'
);
select ok(
  (select qual::text like '%has_company_permission(company_id%attendance.read%'
   from pg_policies
   where schemaname = 'public' and tablename = 'work_schedule_rules'
     and policyname = 'work_schedule_rules_select'),
  'la lectura de reglas queda aislada por empresa'
);
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'work_schedule_rules'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
  and not has_table_privilege('authenticated', 'public.work_schedule_rules', 'INSERT')
  and not has_table_privilege('authenticated', 'public.work_schedule_rules', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.work_schedule_rules', 'DELETE')
  and not has_table_privilege('service_role', 'public.work_schedule_rules', 'INSERT')
  and not has_table_privilege('service_role', 'public.work_schedule_rules', 'UPDATE')
  and not has_table_privilege('service_role', 'public.work_schedule_rules', 'DELETE'),
  'las reglas no admiten DML directo que omita validación y versionado'
);
select ok(
  (select qual::text like '%has_company_permission(company_id%attendance.read%'
       and qual::text like '%employee_belongs_to_active_company(employee_id)%'
   from pg_policies
   where schemaname = 'public' and tablename = 'schedule_assignments'
     and policyname = 'schedule_assignments_select'),
  'la lectura de asignaciones valida empresa y trabajador'
);
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'schedule_assignments'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
  and not has_table_privilege('authenticated', 'public.schedule_assignments', 'INSERT')
  and not has_table_privilege('authenticated', 'public.schedule_assignments', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.schedule_assignments', 'DELETE')
  and not has_table_privilege('service_role', 'public.schedule_assignments', 'INSERT')
  and not has_table_privilege('service_role', 'public.schedule_assignments', 'UPDATE')
  and not has_table_privilege('service_role', 'public.schedule_assignments', 'DELETE'),
  'ningún usuario de sesión puede saltarse el RPC para reescribir o borrar historial'
);

select ok(
  pg_get_functiondef('public.upsert_work_schedule(uuid,text,jsonb)'::regprocedure)
    like '%0a4c0000-0000-0000-0000-000000000001%'
  and pg_get_functiondef('public.upsert_work_schedule(uuid,text,jsonb)'::regprocedure)
    like '%public.upsert_work_schedule(%',
  'la firma compatible queda acotada explícitamente al workspace ARCOTEX'
);
select has_function(
  'public', 'upsert_work_schedule', array['uuid', 'uuid', 'text', 'jsonb'],
  'existe la firma tenant-aware para crear o versionar horarios'
);
select ok(
  pg_get_functiondef('public.upsert_work_schedule(uuid,uuid,text,jsonb)'::regprocedure)
    like '%supersedes_schedule_id%'
  and pg_get_functiondef('public.upsert_work_schedule(uuid,uuid,text,jsonb)'::regprocedure)
    like '%v_existing.definition_version + 1%'
  and pg_get_functiondef('public.upsert_work_schedule(uuid,uuid,text,jsonb)'::regprocedure)
    like '%select 1 from public.schedule_assignments%',
  'editar una definición usada crea una versión nueva en vez de mutarla'
);
select ok(
  pg_get_functiondef('public.upsert_work_schedule(uuid,uuid,text,jsonb)'::regprocedure)
    like '%has_company_app_role(p_company_id, ''ADMIN_RRHH'')%'
  and pg_get_functiondef('public.upsert_work_schedule(uuid,uuid,text,jsonb)'::regprocedure)
    like '%enforce_mfa_for_privileged()%'
  and pg_get_functiondef('public.upsert_work_schedule(uuid,uuid,text,jsonb)'::regprocedure)
    like '%request_is_aal2()%'
  and pg_get_functiondef('public.upsert_work_schedule(uuid,uuid,text,jsonb)'::regprocedure)
    not like '%SUPER_ADMIN%',
  'el versionado exige RR. HH., MFA y membresía explícita'
);
select ok(
  pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%v_employee_company_id <> v_schedule_company_id%'
  and pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%not v_schedule_active%',
  'la asignación rechaza otra empresa y versiones retiradas'
);
select has_function(
  'private', 'assert_arcotex_payroll_range_mutable', array['uuid', 'date', 'date'],
  'existe la frontera de vigencias contra períodos cerrados'
);
select ok(
  pg_get_functiondef('private.assert_arcotex_payroll_range_mutable(uuid,date,date)'::regprocedure)
    like '%payroll-source-mutation-v1%rp.status = ''CLOSED''%daterange%',
  'la frontera serializa con el cierre y bloquea todo solapamiento CLOSED'
);
select ok(
  pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%assert_arcotex_payroll_range_mutable%v_current.effective_to%',
  'una reasignación valida exactamente el tramo histórico que cambiará'
);
select ok(
  pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%v_current.rrhh_confirmed_at is not null%'
  and pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%set effective_to = p_effective_from - 1%'
  and pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%p_effective_from, v_current.effective_to%',
  'confirmar dentro de un rango divide la vigencia y no aprueba fechas anteriores'
);
select ok(
  pg_get_functiondef('public.assign_schedule_to_unassigned(uuid,date)'::regprocedure)
    like '%emp.company_id = v_company_id%'
  and pg_get_functiondef('public.assign_schedule_to_unassigned(uuid,date)'::regprocedure)
    like '%sa.company_id = v_company_id%',
  'la asignación masiva no recorre empleados de otras empresas'
);
select ok(
  not has_function_privilege(
    'anon', 'public.upsert_work_schedule(uuid,uuid,text,jsonb)', 'EXECUTE'
  ),
  'anon no puede crear ni versionar horarios'
);
select ok(
  has_function_privilege(
    'authenticated', 'public.upsert_work_schedule(uuid,uuid,text,jsonb)', 'EXECUTE'
  ),
  'authenticated puede invocar y queda sujeto a rol, MFA y empresa'
);

-- Prueba conductual del bypass: incluso una sesión authenticated que conociera
-- el UUID exacto no puede reescribir ni borrar directamente el historial.
set local role authenticated;
select throws_ok(
  $$ insert into public.work_schedules(name) values ('bypass sin MFA') $$,
  '42501', null,
  'authenticated no puede insertar definiciones directamente'
);
select throws_ok(
  $$ update public.work_schedules set name = name where false $$,
  '42501', null,
  'authenticated no puede editar definiciones directamente'
);
select throws_ok(
  $$ delete from public.work_schedules where false $$,
  '42501', null,
  'authenticated no puede borrar definiciones directamente'
);
select throws_ok(
  $$ insert into public.work_schedule_rules(
       work_schedule_id, day_of_week, scheduled_start, scheduled_end
     ) values (
       '00000000-0000-4000-8000-000000000001', 1, time '08:00', time '17:00'
     ) $$,
  '42501', null,
  'authenticated no puede insertar reglas directamente'
);
select throws_ok(
  $$ update public.work_schedule_rules set day_of_week = day_of_week where false $$,
  '42501', null,
  'authenticated no puede editar reglas directamente'
);
select throws_ok(
  $$ delete from public.work_schedule_rules where false $$,
  '42501', null,
  'authenticated no puede borrar reglas directamente'
);
select throws_ok(
  $$ update public.schedule_assignments
     set confirmation_reason = 'alterado fuera del RPC'
     where false $$,
  '42501',
  null,
  'authenticated no puede ejecutar UPDATE directo ni aunque la consulta no afecte filas'
);
select throws_ok(
  $$ delete from public.schedule_assignments where false $$,
  '42501',
  null,
  'authenticated no puede ejecutar DELETE directo del historial'
);
reset role;

select * from finish();
rollback;
