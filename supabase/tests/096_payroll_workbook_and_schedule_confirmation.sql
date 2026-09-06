-- Se ejecuta únicamente sobre una instancia aislada compatible con todas las
-- migraciones de esta rama. La base local compartida no debe reiniciarse.
create extension if not exists pgtap;

begin;
select plan(26);

select has_column(
  'public', 'payroll_workbook_changes', 'source_value_at_accept',
  'cada ajuste conserva el valor automático contra el que fue aceptado'
);
select has_column(
  'public', 'schedule_assignments', 'rrhh_confirmed_by',
  'la asignación conserva quién confirmó el horario'
);
select has_column(
  'public', 'schedule_assignments', 'rrhh_confirmed_at',
  'la asignación conserva cuándo se confirmó el horario'
);
select has_column(
  'public', 'schedule_assignments', 'confirmation_reason',
  'la confirmación del horario conserva una explicación auditable'
);
select has_function(
  'public', 'apply_schedule_assignment', array['uuid', 'uuid', 'date'],
  'existe la asignación transaccional de horario'
);
select has_function(
  'public', 'register_accepted_payroll_workbook',
  array['uuid', 'date', 'date', 'uuid', 'text', 'integer', 'text', 'text', 'jsonb'],
  'existe el registro transaccional del Excel aceptado'
);
select has_function(
  'public', 'register_accepted_payroll_workbook',
  array['uuid', 'uuid', 'date', 'date', 'uuid', 'text', 'integer', 'text', 'text', 'jsonb', 'bigint', 'text', 'integer', 'text'],
  'la frontera confiable recibe actor, revisión, hash y tamaño verificados'
);

select ok(
  pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%has_company_app_role(v_employee_company_id, ''ADMIN_RRHH'')%'
  and pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%rrhh_confirmed_by = v_actor%'
  and pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%enforce_mfa_for_privileged()%'
  and pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    like '%request_is_aal2()%'
  and pg_get_functiondef('public.apply_schedule_assignment(uuid,uuid,date)'::regprocedure)
    not like '%SUPER_ADMIN%',
  'la confirmación se deriva del ADMIN_RRHH de esa empresa y exige AAL2 real'
);

select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'schedule_assignments'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
  and not has_table_privilege('authenticated', 'public.schedule_assignments', 'INSERT')
  and not has_table_privilege('authenticated', 'public.schedule_assignments', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.schedule_assignments', 'DELETE'),
  'schedule_assignments no admite bypass directo: toda escritura usa el RPC auditado'
);
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'work_schedules'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
  and not has_table_privilege('authenticated', 'public.work_schedules', 'INSERT')
  and not has_table_privilege('authenticated', 'public.work_schedules', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.work_schedules', 'DELETE'),
  'work_schedules solo se escribe mediante el RPC RR. HH. + MFA'
);
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'work_schedule_rules'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
  and not has_table_privilege('authenticated', 'public.work_schedule_rules', 'INSERT')
  and not has_table_privilege('authenticated', 'public.work_schedule_rules', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.work_schedule_rules', 'DELETE'),
  'work_schedule_rules solo se escribe mediante el RPC RR. HH. + MFA'
);
select ok(
  not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'employee_time_control_policies'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  )
  and not has_table_privilege('authenticated', 'public.employee_time_control_policies', 'INSERT')
  and not has_table_privilege('authenticated', 'public.employee_time_control_policies', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.employee_time_control_policies', 'DELETE')
  and pg_get_functiondef(
    'public.set_time_control_exemption(uuid,text,date,text,uuid)'::regprocedure
  ) like '%p_actor_id is distinct from v_actor%'
  and pg_get_functiondef(
    'public.set_time_control_exemption(uuid,text,date,text,uuid)'::regprocedure
  ) like '%has_company_app_role(v_company_id, ''ADMIN_RRHH'')%'
  and pg_get_functiondef(
    'public.set_time_control_exemption(uuid,text,date,text,uuid)'::regprocedure
  ) like '%request_is_aal2()%'
  and pg_get_functiondef(
    'public.clear_time_control_exemption(uuid,date)'::regprocedure
  ) like '%has_company_app_role(v_company_id, ''ADMIN_RRHH'')%'
  and pg_get_functiondef(
    'public.clear_time_control_exemption(uuid,date)'::regprocedure
  ) like '%request_is_aal2()%'
  and pg_get_functiondef(
    'public.set_time_control_exemption(uuid,text,date,text,uuid)'::regprocedure
  ) not like '%SUPER_ADMIN%',
  'las exenciones no tienen DML directo y derivan actor, empresa y AAL2 dentro del RPC'
);

select has_index(
  'public', 'payroll_workbook_conflicts', 'payroll_workbook_conflicts_open_idx',
  'los conflictos abiertos tienen un índice propio'
);
select ok(
  (select i.indisunique
      and pg_get_expr(i.indpred, i.indrelid) ilike '%resolved_at IS NULL%'
   from pg_index i
   join pg_class idx on idx.oid = i.indexrelid
   join pg_class tbl on tbl.oid = i.indrelid
   join pg_namespace ns on ns.oid = tbl.relnamespace
   where ns.nspname = 'public'
     and tbl.relname = 'payroll_workbook_conflicts'
     and idx.relname = 'payroll_workbook_conflicts_open_idx'),
  'solo puede existir un conflicto abierto por empresa, período y clave'
);

select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%jsonb_array_length(p_changes) > 500%',
  'el RPC limita cada aceptación a 500 diferencias revisables'
);
select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%from storage.objects%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%o.owner_id = v_actor::text%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%o.metadata ->> ''size''%',
  'el RPC exige que el objeto privado exista y coincida con actor y tamaño'
);
select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%''^(R|S|U|V|X|Y)([6-9]|[1-9][0-9]+)$''%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%Solo R/S/U/V/X/Y pueden ejecutarse en el resumen.%',
  'el resumen limita los cambios de negocio a R/S/U/V/X/Y'
);
select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%MATRIZ_DIARIA_SABANA%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%ATTENDANCE_STATUS_CODE%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  not like '%''R''%Código asistencia%',
  'la matriz normaliza trabajador, fecha y código diario, sin permitir R'
);
select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%Todo ajuste distinto de cero exige su motivo específico emparejado.%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%sourceValueAtComparison%' || '%v_scale%',
  'el RPC exige pareja de motivo y conciliación no negativa desde la fuente'
);
select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%split_part(x ->> ''stableKey'', ''|'', 2)::date%',
  'la fecha estable diaria se persiste como work_date'
);
select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%source_value_at_accept%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%sourceValueAtComparison%',
  'el RPC persiste el origen automático de cada ajuste'
);
select ok(
  pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%HH50_ADJUSTMENT_MINUTES%'
  and pg_get_functiondef(
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)'::regprocedure
  ) like '%split_part(x ->> ''stableKey''%',
  'trabajador, clave estable y field_code se derivan dentro del RPC'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)',
    'EXECUTE'
  ),
  'anon no puede registrar archivos de pre-nómina'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb)',
    'EXECUTE'
  ),
  'authenticated no puede omitir la revisión de fuentes usando la firma histórica'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.register_accepted_payroll_workbook(uuid,date,date,uuid,text,integer,text,text,jsonb,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
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
  'solo service_role puede cruzar la frontera con bytes e identidad Storage verificados'
);
select ok(
  not has_function_privilege(
    'anon', 'public.apply_schedule_assignment(uuid,uuid,date)', 'EXECUTE'
  ),
  'anon no puede confirmar horarios'
);

select * from finish();
rollback;
