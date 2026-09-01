-- pgTAP GESTORA MT-3A: hard gates, RPC-only writes y OWNER/audit invariants.
create extension if not exists pgtap;

begin;
select plan(51);

select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'companies'
      and con.conname = 'companies_lifecycle_active_chk'
      and con.contype = 'c'
  ),
  'companies mantiene active coherente con su ciclo de vida'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'companies'
      and con.conname = 'companies_workspace_mt3a_gate_chk'
      and con.contype = 'c'
  ),
  'existe el gate temporal del unico workspace MT-3A'
);
select has_function(
  'public', 'enforce_operational_company_workspace_enabled', array[]::text[],
  'existe el guard de escrituras laborales por workspace'
);
select has_trigger(
  'public', 'employee_groups', 'employee_groups_require_enabled_workspace',
  'employee_groups valida el workspace antes de escribir'
);
select has_trigger(
  'public', 'employees', 'employees_require_enabled_workspace',
  'employees valida el workspace antes de escribir'
);
select has_trigger(
  'public', 'platform_audit_log', 'platform_audit_log_immutable',
  'la auditoria del control plane es append-only'
);
select has_trigger(
  'public', 'profiles', 'profiles_preserve_last_platform_owner',
  'profiles protege al ultimo OWNER de plataforma'
);
select has_index(
  'public', 'organization_units', 'organization_units_company_parent_idx',
  'el arbol organizacional indexa company_id y parent_id'
);

select is(
  (
    select count(*)
    from (values
      ('companies'),
      ('company_memberships'),
      ('platform_memberships'),
      ('company_roles'),
      ('company_role_permissions'),
      ('company_membership_roles'),
      ('company_modules'),
      ('company_invitations'),
      ('company_onboarding_steps'),
      ('organization_units'),
      ('job_positions'),
      ('employee_org_assignments'),
      ('organization_unit_leads'),
      ('reporting_lines'),
      ('membership_org_scopes'),
      ('platform_audit_log')
    ) as protected(table_name)
    where has_table_privilege(
      'authenticated', 'public.' || protected.table_name, 'SELECT'
    )
  ),
  16::bigint,
  'authenticated conserva SELECT sobre todo el control plane protegido'
);

select is(
  (
    select count(*)
    from (values
      ('companies'),
      ('company_memberships'),
      ('platform_memberships'),
      ('company_roles'),
      ('company_role_permissions'),
      ('company_membership_roles'),
      ('company_modules'),
      ('company_invitations'),
      ('company_onboarding_steps'),
      ('organization_units'),
      ('job_positions'),
      ('employee_org_assignments'),
      ('organization_unit_leads'),
      ('reporting_lines'),
      ('membership_org_scopes'),
      ('platform_audit_log')
    ) as protected(table_name)
    where has_table_privilege(
      'authenticated', 'public.' || protected.table_name, 'INSERT'
    )
       or has_table_privilege(
      'authenticated', 'public.' || protected.table_name, 'UPDATE'
    )
       or has_table_privilege(
      'authenticated', 'public.' || protected.table_name, 'DELETE'
    )
  ),
  0::bigint,
  'authenticated no puede mutar directamente ninguna tabla del control plane'
);

select ok(
  not has_sequence_privilege(
    'anon', 'public.platform_audit_log_id_seq', 'USAGE'
  )
  and not has_sequence_privilege(
    'anon', 'public.platform_audit_log_id_seq', 'SELECT'
  )
  and not has_sequence_privilege(
    'anon', 'public.platform_audit_log_id_seq', 'UPDATE'
  )
  and not has_sequence_privilege(
    'authenticated', 'public.platform_audit_log_id_seq', 'USAGE'
  )
  and not has_sequence_privilege(
    'authenticated', 'public.platform_audit_log_id_seq', 'SELECT'
  )
  and not has_sequence_privilege(
    'authenticated', 'public.platform_audit_log_id_seq', 'UPDATE'
  ),
  'anon/authenticated no controlan la secuencia de auditoria'
);

select ok(
  not exists (
    select 1
    from pg_catalog.pg_default_acl d
    join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    left join pg_catalog.pg_roles grantee on grantee.oid = a.grantee
    where n.nspname = 'public'
      and pg_catalog.pg_get_userbyid(d.defaclrole) = current_user
      and d.defaclobjtype in ('S', 'f')
      and (a.grantee = 0 or grantee.rolname in ('anon', 'authenticated'))
  ),
  'los defaults de funciones/secuencias futuras son deny-by-default'
);

select ok(
  (
    select workspace_enabled and active and status = 'ACTIVE'
    from public.companies
    where id = '0a4c0000-0000-0000-0000-000000000001'
  ),
  'ARCOTEX conserva el workspace habilitado sin romper su ciclo de vida'
);

insert into public.profiles (id, display_name, role, active) values
  ('95000000-0000-0000-0000-000000000101', 'Platform Owner Hardening', null, true),
  ('95000000-0000-0000-0000-000000000102', 'Inactive Owner Target', null, false),
  ('95000000-0000-0000-0000-000000000103', 'Client Member Hardening', null, true);

insert into public.platform_memberships (user_id, role, active)
values ('95000000-0000-0000-0000-000000000101', 'OWNER', true);

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  '95000000-0000-0000-0000-000000000001',
  'Cliente Hardening',
  'Cliente Hardening SpA',
  'cliente-hardening-041',
  true,
  'ONBOARDING',
  false
);

insert into public.company_memberships (
  id, user_id, company_id, role, active
) values (
  '95000000-0000-0000-0000-000000000201',
  '95000000-0000-0000-0000-000000000103',
  '95000000-0000-0000-0000-000000000001',
  'ADMIN_RRHH',
  true
);

insert into public.company_membership_roles (
  company_id, membership_id, role_id
)
select
  '95000000-0000-0000-0000-000000000001',
  '95000000-0000-0000-0000-000000000201',
  cr.id
from public.company_roles cr
where cr.company_id = '95000000-0000-0000-0000-000000000001'
  and cr.code = 'HR_ADMIN';

select throws_ok(
  $$update public.companies
    set workspace_enabled = true, status = 'ACTIVE'
    where id = '95000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'una empresa distinta de ARCOTEX no puede abrir su workspace'
);

select throws_ok(
  $$insert into public.companies (
      id, name, slug, active, status, workspace_enabled
    ) values (
      '95000000-0000-0000-0000-000000000002',
      'Lifecycle Invalido',
      'lifecycle-invalido-041',
      true,
      'SUSPENDED',
      false
    )$$,
  '23514',
  null,
  'SUSPENDED no puede coexistir con active=true'
);

select throws_ok(
  $$insert into public.employee_groups (
      id, company_id, code, name, active
    ) values (
      '95000000-0000-0000-0000-000000000301',
      '95000000-0000-0000-0000-000000000001',
      'BLOCKED_041',
      'Blocked 041',
      true
    )$$,
  '23514',
  'El workspace de la empresa esta bloqueado para datos laborales.',
  'un workspace bloqueado no acepta employee_groups'
);

select throws_ok(
  $$insert into public.employees (
      id, company_id, external_workera_id,
      first_name, last_name, display_name, active
    ) values (
      '95000000-0000-0000-0000-000000000302',
      '95000000-0000-0000-0000-000000000001',
      'BLOCKED-EMPLOYEE-041',
      'Persona',
      'Bloqueada',
      'Persona Bloqueada',
      true
    )$$,
  '23514',
  'El workspace de la empresa esta bloqueado para datos laborales.',
  'un workspace bloqueado no acepta employees'
);

select lives_ok(
  $$insert into public.employees (
      id, company_id, external_workera_id,
      first_name, last_name, display_name, active
    ) values (
      '95000000-0000-0000-0000-000000000303',
      '0a4c0000-0000-0000-0000-000000000001',
      'ARCOTEX-EMPLOYEE-041',
      'Persona',
      'Arcotex',
      'Persona Arcotex',
      true
    )$$,
  'el workspace ARCOTEX sigue aceptando filas laborales'
);

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000103';
select ok(
  public.is_active_company_member('95000000-0000-0000-0000-000000000001'),
  'ONBOARDING activo permite configurar al miembro del cliente'
);
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000101';

select throws_ok(
  $$insert into public.companies (
      id, name, slug, active, status, workspace_enabled,
      created_by
    ) values (
      '95000000-0000-0000-0000-000000000009',
      'Alta Directa 041',
      'alta-directa-041',
      true,
      'ONBOARDING',
      false,
      '95000000-0000-0000-0000-000000000101'
    )$$,
  '42501',
  null,
  'el alta de empresa exige el RPC auditado'
);

select throws_ok(
  $$update public.company_memberships
    set role = 'SUPER_ADMIN'
    where id = '95000000-0000-0000-0000-000000000201'$$,
  '42501',
  null,
  'una membresia no eleva su rol legacy con DML directo'
);

select throws_ok(
  $$update public.platform_memberships
    set role = 'ADMIN'
    where user_id = '95000000-0000-0000-0000-000000000101'$$,
  '42501',
  null,
  'la administracion global permanece read-only sin RPC auditado'
);

select throws_ok(
  $$insert into public.company_role_permissions (
      company_id, role_id, permission_code
    )
    select
      '95000000-0000-0000-0000-000000000001',
      cr.id,
      'modules.manage'
    from public.company_roles cr
    where cr.company_id = '95000000-0000-0000-0000-000000000001'
      and cr.code = 'HR_ADMIN'$$,
  '42501',
  null,
  'los permisos de roles no se amplian con DML directo'
);

select throws_ok(
  $$insert into public.job_positions (
      company_id, code, title
    ) values (
      '95000000-0000-0000-0000-000000000001',
      'DIRECT_041',
      'Cargo directo 041'
    )$$,
  '42501',
  null,
  'las tablas organizacionales sin RPC permanecen read-only'
);

select throws_ok(
  $$insert into public.company_membership_roles (
      company_id, membership_id, role_id, assigned_by
    )
    select
      '95000000-0000-0000-0000-000000000001',
      '95000000-0000-0000-0000-000000000201',
      cr.id,
      '95000000-0000-0000-0000-000000000101'
    from public.company_roles cr
    where cr.company_id = '95000000-0000-0000-0000-000000000001'
      and cr.code = 'COMPANY_OWNER'$$,
  '42501',
  null,
  'ni un OWNER de plataforma asigna roles con DML directo'
);

select throws_ok(
  $$update public.company_modules
    set status = 'ENABLED', enabled_at = now(),
        enabled_by = '95000000-0000-0000-0000-000000000101'
    where company_id = '95000000-0000-0000-0000-000000000001'
      and module_key = 'expenses'$$,
  '42501',
  null,
  'los entitlements no se cambian con DML directo'
);

select throws_ok(
  $$update public.company_onboarding_steps
    set status = 'COMPLETE', completed_at = now(),
        completed_by = '95000000-0000-0000-0000-000000000101'
    where company_id = '95000000-0000-0000-0000-000000000001'
      and step_key = 'company_profile'$$,
  '42501',
  null,
  'onboarding no se cambia con DML directo'
);

select throws_ok(
  $$insert into public.company_invitations (
      company_id, email, role_id, invited_by
    )
    select
      '95000000-0000-0000-0000-000000000001',
      'directa-041@example.com',
      cr.id,
      '95000000-0000-0000-0000-000000000101'
    from public.company_roles cr
    where cr.company_id = '95000000-0000-0000-0000-000000000001'
      and cr.code = 'HR_ADMIN'$$,
  '42501',
  null,
  'invitaciones no se crean con DML directo'
);

select throws_ok(
  $$insert into public.organization_units (
      company_id, parent_id, code, name, unit_type, created_by
    )
    select
      '95000000-0000-0000-0000-000000000001',
      root.id,
      'DIRECT_041',
      'Directa 041',
      'TEAM',
      '95000000-0000-0000-0000-000000000101'
    from public.organization_units root
    where root.company_id = '95000000-0000-0000-0000-000000000001'
      and root.code = 'ROOT'$$,
  '42501',
  null,
  'organizacion no se cambia con DML directo'
);

select throws_ok(
  $$insert into public.platform_audit_log (
      actor_id, company_id, action, target_type
    ) values (
      '95000000-0000-0000-0000-000000000101',
      '95000000-0000-0000-0000-000000000001',
      'forged.event',
      'test'
    )$$,
  '42501',
  null,
  'un actor autenticado no fabrica eventos de auditoria'
);

select lives_ok(
  format(
    $$select public.platform_assign_company_role(
      '95000000-0000-0000-0000-000000000201', %L
    )$$,
    (
      select cr.id
      from public.company_roles cr
      where cr.company_id = '95000000-0000-0000-0000-000000000001'
        and cr.code = 'PRODUCTION_SUPERVISOR'
    )
  ),
  'el RPC auditado sigue asignando roles'
);

select is(
  (
    select cr.code
    from public.company_membership_roles cmr
    join public.company_roles cr on cr.id = cmr.role_id
    where cmr.membership_id = '95000000-0000-0000-0000-000000000201'
  ),
  'PRODUCTION_SUPERVISOR',
  'la asignacion RPC reemplaza el rol anterior'
);

select lives_ok(
  $$select public.platform_set_company_module_status(
      '95000000-0000-0000-0000-000000000001', 'expenses', 'PILOT'
    )$$,
  'el RPC auditado sigue cambiando entitlements'
);

select ok(
  (
    select status = 'PILOT'
      and enabled_at is not null
      and enabled_by = '95000000-0000-0000-0000-000000000101'
    from public.company_modules
    where company_id = '95000000-0000-0000-0000-000000000001'
      and module_key = 'expenses'
  ),
  'el RPC conserva metadata coherente del entitlement'
);

select lives_ok(
  $$select public.platform_set_onboarding_step_completed(
      '95000000-0000-0000-0000-000000000001', 'company_profile', true
    )$$,
  'el RPC auditado sigue completando onboarding'
);

select lives_ok(
  format(
    $$select public.platform_create_company_invitation(
      '95000000-0000-0000-0000-000000000001',
      'rpc-041@example.com',
      %L
    )$$,
    (
      select cr.id
      from public.company_roles cr
      where cr.company_id = '95000000-0000-0000-0000-000000000001'
        and cr.code = 'HR_ADMIN'
    )
  ),
  'el RPC auditado sigue creando invitaciones'
);

select lives_ok(
  format(
    $$select public.platform_create_organization_unit(
      '95000000-0000-0000-0000-000000000001',
      %L,
      'RPC_041',
      'Unidad RPC 041',
      'TEAM',
      10
    )$$,
    (
      select root.id
      from public.organization_units root
      where root.company_id = '95000000-0000-0000-0000-000000000001'
        and root.code = 'ROOT'
    )
  ),
  'el RPC auditado sigue creando unidades'
);

select is(
  (
    select count(*)::integer
    from public.platform_audit_log
    where company_id = '95000000-0000-0000-0000-000000000001'
  ),
  5,
  'las cinco mutaciones RPC quedan auditadas y las directas no'
);

reset role;

-- Dejar al fixture como unico OWNER efectivo para probar ambas rutas de
-- remocion. El trigger de membresia serializa cada degradacion con este OWNER.
update public.platform_memberships
set role = 'VIEWER'
where user_id <> '95000000-0000-0000-0000-000000000101'
  and role = 'OWNER';

select throws_ok(
  $$update public.platform_memberships
    set user_id = '95000000-0000-0000-0000-000000000102'
    where user_id = '95000000-0000-0000-0000-000000000101'$$,
  '23514',
  'La identidad de una membresia de plataforma es inmutable.',
  'no se transfiere el ultimo OWNER cambiando su user_id'
);

select throws_ok(
  $$update public.profiles
    set active = false
    where id = '95000000-0000-0000-0000-000000000101'$$,
  '23514',
  'No se puede desactivar el perfil del ultimo OWNER activo de la plataforma.',
  'no se desactiva el perfil del ultimo OWNER'
);

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000101';
select ok(
  public.is_platform_admin(),
  'el OWNER sigue efectivo despues de ambos intentos rechazados'
);
reset role;

select throws_ok(
  $$update public.platform_audit_log
    set action = 'tampered.event'
    where company_id = '95000000-0000-0000-0000-000000000001'$$,
  '55000',
  'platform_audit_log es append-only.',
  'ni el owner SQL actualiza auditoria existente'
);

select throws_ok(
  $$delete from public.platform_audit_log
    where company_id = '95000000-0000-0000-0000-000000000001'$$,
  '55000',
  'platform_audit_log es append-only.',
  'ni el owner SQL elimina auditoria existente'
);

select throws_ok(
  $$truncate table public.platform_audit_log$$,
  '55000',
  'platform_audit_log es append-only.',
  'ni el owner SQL trunca la auditoria'
);

select throws_ok(
  $$update public.companies
    set status = 'SUSPENDED'
    where id = '95000000-0000-0000-0000-000000000001'$$,
  '23514',
  null,
  'el estado no puede suspenderse dejando active=true'
);

select lives_ok(
  $$update public.companies
    set status = 'SUSPENDED', active = false
    where id = '95000000-0000-0000-0000-000000000001'$$,
  'la transicion coherente a SUSPENDED se permite'
);

set local role authenticated;
set local request.jwt.claim.sub = '95000000-0000-0000-0000-000000000103';

select ok(
  not public.is_active_company_member('95000000-0000-0000-0000-000000000001'),
  'SUSPENDED revoca is_active_company_member'
);
select is(
  (select count(*)::integer from public.active_company_memberships()),
  0,
  'SUSPENDED desaparece de active_company_memberships'
);
select ok(
  not public.has_company_permission(
    '95000000-0000-0000-0000-000000000001', 'employees.read'
  ),
  'SUSPENDED revoca permisos empresariales'
);
select ok(
  not public.company_has_module(
    '95000000-0000-0000-0000-000000000001', 'expenses'
  ),
  'SUSPENDED revoca tambien el entitlement efectivo'
);

reset role;
select ok(
  (
    select not active and status = 'SUSPENDED'
    from public.companies
    where id = '95000000-0000-0000-0000-000000000001'
  ),
  'la empresa queda persistida en un lifecycle coherente'
);

select * from finish();
rollback;
