-- pgTAP: la conciliación Workera aplica un plan cerrado, tenant-aware e
-- idempotente dentro de una única transacción de base de datos.
create extension if not exists pgtap;

begin;
select plan(40);

select has_function(
  'public',
  'apply_workera_roster_reconciliation',
  array['uuid', 'jsonb', 'jsonb', 'jsonb'],
  'existe el RPC atómico de conciliación Workera'
);

select volatility_is(
  'public',
  'apply_workera_roster_reconciliation',
  array['uuid', 'jsonb', 'jsonb', 'jsonb'],
  'volatile',
  'el RPC declara que escribe estado'
);

select ok(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid = 'public.apply_workera_roster_reconciliation(uuid,jsonb,jsonb,jsonb)'::regprocedure
  ),
  'el RPC es SECURITY DEFINER y valida autorización internamente'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.apply_workera_roster_reconciliation(uuid,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'authenticated puede invocar la frontera controlada'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.apply_workera_roster_reconciliation(uuid,jsonb,jsonb,jsonb)',
    'EXECUTE'
  ),
  'anon no puede conciliar el roster'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'public.apply_workera_roster_reconciliation(uuid,jsonb,jsonb,jsonb)'::regprocedure
  ) ~ 'hashtextextended\(''employee_roster:'' \|\| p_company_id::text, 0\)',
  'el RPC comparte el lock employee_roster:<company_id> con otros importadores'
);

select ok(
  (
    select p.prosrc like '%public.has_company_app_role(p_company_id, ''ADMIN_RRHH'')%'
      and p.prosrc like '%public.has_company_app_role(p_company_id, ''SUPER_ADMIN'')%'
      and p.prosrc not like '%is_privileged_admin%'
      and p.prosrc not like '%is_active_company_member%'
    from pg_catalog.pg_proc p
    where p.oid = 'public.apply_workera_roster_reconciliation(uuid,jsonb,jsonb,jsonb)'::regprocedure
  ),
  'la base exige un rol administrativo asignado dentro de la empresa destino'
);

-- El trigger de compatibilidad crea automáticamente membresías ARCOTEX para
-- perfiles con rol. La tercera cuenta se elimina deliberadamente de ese
-- tenant para probar que el rol global, por sí solo, no basta.
insert into public.profiles (id, display_name, role, active) values
  ('11110000-0000-4000-8000-000000000101', 'RRHH roster 111', 'ADMIN_RRHH', true),
  ('11110000-0000-4000-8000-000000000102', 'Supervisor roster 111', 'SUPERVISOR_PRODUCTION', true),
  ('11110000-0000-4000-8000-000000000103', 'RRHH sin empresa 111', 'ADMIN_RRHH', true);

delete from public.company_membership_roles
where membership_id in (
  select cm.id
  from public.company_memberships cm
  where cm.user_id = '11110000-0000-4000-8000-000000000103'
    and cm.company_id = '0a4c0000-0000-0000-0000-000000000001'
);
delete from public.company_memberships
where user_id = '11110000-0000-4000-8000-000000000103'
  and company_id = '0a4c0000-0000-0000-0000-000000000001';

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  '11110000-0000-4000-8000-000000000002',
  'Tenant aislado roster 111',
  'Tenant aislado roster 111 SpA',
  'tenant-aislado-roster-111',
  true,
  'ONBOARDING',
  false
);

-- El administrador legacy de ARCOTEX participa también en el segundo tenant,
-- pero allí sólo como supervisor. Este fixture demuestra que el rol de una
-- empresa no se hereda hacia otra por tener una membresía activa cualquiera.
insert into public.company_memberships (
  id, user_id, company_id, role, active
) values (
  '11110000-0000-4000-8000-000000000211',
  '11110000-0000-4000-8000-000000000101',
  '11110000-0000-4000-8000-000000000002',
  'SUPERVISOR_PRODUCTION',
  true
);

insert into public.company_membership_roles (
  company_id, membership_id, role_id
)
select
  '11110000-0000-4000-8000-000000000002'::uuid,
  '11110000-0000-4000-8000-000000000211'::uuid,
  cr.id
from public.company_roles cr
where cr.company_id = '11110000-0000-4000-8000-000000000002'
  and cr.base_role = 'SUPERVISOR_PRODUCTION';

insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  source, active, updated_at
) values
  (
    '11110000-0000-4000-8000-000000000301',
    '0a4c0000-0000-0000-0000-000000000001',
    'SHARED-CODE-111', 'Estado', 'Uno', 'Estado Uno', 'workera', true,
    '2000-01-01 00:00:00+00'
  ),
  (
    '11110000-0000-4000-8000-000000000302',
    '0a4c0000-0000-0000-0000-000000000001',
    'REACTIVATE-111', 'Estado', 'Dos', 'Estado Dos', 'workera', false,
    '2000-01-01 00:00:00+00'
  ),
  (
    '11110000-0000-4000-8000-000000000303',
    '0a4c0000-0000-0000-0000-000000000001',
    'EXCEL-PROMOTE-111', 'Promoción', 'Válida', 'Promoción Válida',
    'excel_roster', false, '2000-01-01 00:00:00+00'
  ),
  (
    '11110000-0000-4000-8000-000000000304',
    '0a4c0000-0000-0000-0000-000000000001',
    'EXCEL-STALE-111', 'Promoción', 'Pendiente', 'Promoción Pendiente',
    'excel_roster', true, '2000-01-01 00:00:00+00'
  ),
  (
    '11110000-0000-4000-8000-000000000305',
    '0a4c0000-0000-0000-0000-000000000001',
    'WORKERA-EXISTING-111', 'Workera', 'Existente', 'Workera Existente',
    'workera', true, '2000-01-01 00:00:00+00'
  ),
  (
    '11110000-0000-4000-8000-000000000306',
    '0a4c0000-0000-0000-0000-000000000001',
    'ABA-REVISION-111', 'Revisión', 'ABA', 'Revisión ABA',
    'workera', false, '2000-01-01 00:00:00+00'
  );

-- El segundo workspace permanece cerrado por diseño. Este fixture histórico
-- solo permite demostrar que ni UUID ni código de otro tenant se pueden usar;
-- replica desactiva temporalmente triggers, no constraints ni el test del RPC.
set local session_replication_role = replica;
insert into public.employees (
  id, company_id, external_workera_id, first_name, last_name, display_name,
  source, active, updated_at
) values (
  '11110000-0000-4000-8000-000000000401',
  '11110000-0000-4000-8000-000000000002',
  'SHARED-CODE-111', 'Otro', 'Tenant', 'Otro Tenant', 'workera', true,
  '2000-01-01 00:00:00+00'
);
set local session_replication_role = origin;

set local role authenticated;
set local request.jwt.claim.sub = '11110000-0000-4000-8000-000000000102';

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":false}]',
      '[]',
      '[]'
    )
  $$,
  '42501', null,
  'un supervisor no puede aplicar la conciliación'
);

set local request.jwt.claim.sub = '11110000-0000-4000-8000-000000000103';
select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":false}]',
      '[]',
      '[]'
    )
  $$,
  '42501', null,
  'un administrador sin membresía activa tampoco puede conciliar'
);

set local request.jwt.claim.sub = '11110000-0000-4000-8000-000000000101';

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '11110000-0000-4000-8000-000000000002',
      '[{"id":"11110000-0000-4000-8000-000000000401","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":false}]',
      '[]',
      '[]'
    )
  $$,
  '42501', null,
  'un rol administrativo de ARCOTEX no se hereda hacia una membresía supervisora de otro tenant'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      null,
      '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":false}]',
      '[]',
      '[]'
    )
  $$,
  '22023', null,
  'company_id es obligatorio'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001', '[]', '[]', '[]'
    )
  $$,
  '22023', null,
  'un plan completamente vacío se rechaza'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001', '{}', '[]', '[]'
    )
  $$,
  '22023', null,
  'cada bloque debe ser un arreglo JSON'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":false,"unexpected":1}]',
      '[]',
      '[]'
    )
  $$,
  '22023', null,
  'claves inesperadas no amplían silenciosamente el contrato'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[]',
      '[]',
      '[{"external_workera_id":"WORKERA-BLANK-111","first_name":" ","last_name":"Persona","display_name":"Persona","active":true}]'
    )
  $$,
  '22023', null,
  'los textos obligatorios no aceptan valores vacíos'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":"false"}]',
      '[]',
      '[]'
    )
  $$,
  '22023', null,
  'active debe ser un booleano JSON real'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_updated_at":"2000-01-01T00:00:00Z","active":false}]',
      '[]',
      '[]'
    )
  $$,
  '22023', null,
  'cada actualización de vigencia exige prior_active booleano'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"active":false}]',
      '[]',
      '[]'
    )
  $$,
  '22023', null,
  'cada actualización de vigencia exige prior_updated_at string'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"no-es-un-timestamp","active":false}]',
      '[]',
      '[]'
    )
  $$,
  '22023', null,
  'prior_updated_at debe representar un timestamptz válido'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[]',
      '[{"id":"11110000-0000-4000-8000-000000000303","prior_external_workera_id":"EXCEL-PROMOTE-111","external_workera_id":"WORKERA-PROMOTED-111","prior_active":false,"prior_updated_at":"2000-01-01T00:00:00Z","active":false}]',
      '[]'
    )
  $$,
  '22023', null,
  'una coincidencia administrativa por nombre nunca puede aplicar una baja Workera'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":false},{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
      '[]',
      '[]'
    )
  $$,
  '22023', null,
  'un mismo trabajador no puede aparecer dos veces en el plan'
);

select is(
  public.apply_workera_roster_reconciliation(
    '0a4c0000-0000-0000-0000-000000000001',
    '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":false},{"id":"11110000-0000-4000-8000-000000000302","external_workera_id":"REACTIVATE-111","prior_active":false,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
    '[{"id":"11110000-0000-4000-8000-000000000303","prior_external_workera_id":"EXCEL-PROMOTE-111","external_workera_id":"WORKERA-PROMOTED-111","prior_active":false,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
    '[{"external_workera_id":"WORKERA-NEW-111","first_name":"Persona","last_name":"Nueva","display_name":"Persona Nueva","active":true}]'
  ),
  '{"status_updated_count":3,"promoted_count":1,"inserted_count":1}'::jsonb,
  'el plan válido cuenta también la activación causada por una promoción'
);

reset role;

select is(
  (select e.active from public.employees e where e.id = '11110000-0000-4000-8000-000000000301'),
  false,
  'una baja Workera queda aplicada'
);

select is(
  (select e.active from public.employees e where e.id = '11110000-0000-4000-8000-000000000302'),
  true,
  'una reactivación Workera queda aplicada'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'external_workera_id', e.external_workera_id,
      'source', e.source,
      'active', e.active
    )
    from public.employees e
    where e.id = '11110000-0000-4000-8000-000000000303'
  ),
  '{"external_workera_id":"WORKERA-PROMOTED-111","source":"workera","active":true}'::jsonb,
  'la promoción conserva la fila y eleva su fuente a Workera'
);

select is(
  (
    select pg_catalog.jsonb_build_object(
      'company_id', e.company_id,
      'source', e.source,
      'active', e.active,
      'display_name', e.display_name
    )
    from public.employees e
    where e.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and e.external_workera_id = 'WORKERA-NEW-111'
  ),
  '{"company_id":"0a4c0000-0000-0000-0000-000000000001","source":"workera","active":true,"display_name":"Persona Nueva"}'::jsonb,
  'el alta escribe company_id explícito y la fuente oficial'
);

select is(
  (
    select e.active
    from public.employees e
    where e.id = '11110000-0000-4000-8000-000000000401'
      and e.company_id = '11110000-0000-4000-8000-000000000002'
  ),
  true,
  'un código homónimo de otro tenant permanece intacto'
);

set local role authenticated;
set local request.jwt.claim.sub = '11110000-0000-4000-8000-000000000101';

select is(
  public.apply_workera_roster_reconciliation(
    '0a4c0000-0000-0000-0000-000000000001',
    '[{"id":"11110000-0000-4000-8000-000000000301","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":false},{"id":"11110000-0000-4000-8000-000000000302","external_workera_id":"REACTIVATE-111","prior_active":false,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
    '[{"id":"11110000-0000-4000-8000-000000000303","prior_external_workera_id":"EXCEL-PROMOTE-111","external_workera_id":"WORKERA-PROMOTED-111","prior_active":false,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
    '[{"external_workera_id":"WORKERA-NEW-111","first_name":"Persona","last_name":"Nueva","display_name":"Persona Nueva","active":true}]'
  ),
  '{"status_updated_count":0,"promoted_count":0,"inserted_count":0}'::jsonb,
  'repetir el mismo plan confirmado es un no-op idempotente'
);

reset role;
select is(
  (
    select count(*)
    from public.employees e
    where e.company_id = '0a4c0000-0000-0000-0000-000000000001'
      and e.external_workera_id = 'WORKERA-NEW-111'
  ),
  1::bigint,
  'el reintento no duplica altas'
);

-- Reproduce ABA con dos planes válidos: A activa desde la revisión inicial y
-- B vuelve a desactivar desde la revisión producida por A. Aunque al final el
-- booleano coincide otra vez con el prior_active de A, la revisión ya cambió.
set local role authenticated;
set local request.jwt.claim.sub = '11110000-0000-4000-8000-000000000101';

select is(
  public.apply_workera_roster_reconciliation(
    '0a4c0000-0000-0000-0000-000000000001',
    '[{"id":"11110000-0000-4000-8000-000000000306","external_workera_id":"ABA-REVISION-111","prior_active":false,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
    '[]',
    '[]'
  ),
  '{"status_updated_count":1,"promoted_count":0,"inserted_count":0}'::jsonb,
  'el plan A aplica desde la revisión exacta que observó'
);

select is(
  public.apply_workera_roster_reconciliation(
    '0a4c0000-0000-0000-0000-000000000001',
    (
      select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id', e.id,
        'external_workera_id', e.external_workera_id,
        'prior_active', e.active,
        'prior_updated_at', e.updated_at,
        'active', false
      ))
      from public.employees e
      where e.id = '11110000-0000-4000-8000-000000000306'
    ),
    '[]',
    '[]'
  ),
  '{"status_updated_count":1,"promoted_count":0,"inserted_count":0}'::jsonb,
  'el plan B aplica desde la revisión que dejó A y completa el ciclo ABA'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000306","external_workera_id":"ABA-REVISION-111","prior_active":false,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
      '[]',
      '[]'
    )
  $$,
  '40001', null,
  'repetir A tras A-B falla por revisión obsoleta aunque prior_active coincida'
);

reset role;
select is(
  (select e.active from public.employees e where e.id = '11110000-0000-4000-8000-000000000306'),
  false,
  'el replay ABA rechazado no altera la decisión más reciente'
);

-- Después del replay equivalente, una decisión posterior cambia la vigencia.
-- Reenviar el plan antiguo ya no puede tratarse como el mismo no-op.
update public.employees
set active = false
where id = '11110000-0000-4000-8000-000000000303';

set local role authenticated;
set local request.jwt.claim.sub = '11110000-0000-4000-8000-000000000101';

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[]',
      '[{"id":"11110000-0000-4000-8000-000000000303","prior_external_workera_id":"EXCEL-PROMOTE-111","external_workera_id":"WORKERA-PROMOTED-111","prior_active":false,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
      '[]'
    )
  $$,
  '40001', null,
  'un replay antiguo falla cerrado si el estado promovido divergió después'
);

reset role;
update public.employees
set active = true
where id = '11110000-0000-4000-8000-000000000303';

set local role authenticated;
set local request.jwt.claim.sub = '11110000-0000-4000-8000-000000000101';

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      (
        select pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'id', e.id,
          'external_workera_id', e.external_workera_id,
          'prior_active', e.active,
          'prior_updated_at', e.updated_at,
          'active', false
        ))
        from public.employees e
        where e.id = '11110000-0000-4000-8000-000000000302'
      ),
      '[{"id":"11110000-0000-4000-8000-000000000304","prior_external_workera_id":"EXCEL-CODE-QUE-YA-NO-ES","external_workera_id":"WORKERA-STALE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
      '[]'
    )
  $$,
  '40001', null,
  'un estado previo obsoleto aborta el plan completo'
);

reset role;
select is(
  (select e.active from public.employees e where e.id = '11110000-0000-4000-8000-000000000302'),
  true,
  'la actualización anterior al conflicto también se revierte'
);

set local role authenticated;
set local request.jwt.claim.sub = '11110000-0000-4000-8000-000000000101';

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[]',
      '[{"id":"11110000-0000-4000-8000-000000000305","prior_external_workera_id":"WORKERA-EXISTING-111","external_workera_id":"WORKERA-ILLEGAL-PROMOTION-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
      '[]'
    )
  $$,
  '40001', null,
  'una fila Workera no se puede promover como si fuera provisional'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[]',
      '[]',
      '[{"external_workera_id":"WORKERA-EXISTING-111","first_name":"Otra","last_name":"Persona","display_name":"Otra Persona","active":true}]'
    )
  $$,
  '40001', null,
  'un alta repetida con datos divergentes falla cerrada'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[{"id":"11110000-0000-4000-8000-000000000401","external_workera_id":"SHARED-CODE-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":false}]',
      '[]',
      '[]'
    )
  $$,
  '40001', null,
  'un UUID de otro tenant no atraviesa el filtro company_id'
);

select throws_ok(
  $$
    select public.apply_workera_roster_reconciliation(
      '0a4c0000-0000-0000-0000-000000000001',
      '[]',
      '[{"id":"11110000-0000-4000-8000-000000000304","prior_external_workera_id":"EXCEL-STALE-111","external_workera_id":"WORKERA-EXISTING-111","prior_active":true,"prior_updated_at":"2000-01-01T00:00:00Z","active":true}]',
      '[]'
    )
  $$,
  '40001', null,
  'una promoción no puede apropiarse del código de otra ficha'
);

reset role;
select * from finish();
rollback;
