-- pgTAP: expiración, idempotencia y timestamps estables en transiciones del
-- control plane, más propagación del catálogo de onboarding.
create extension if not exists pgtap;

begin;
select plan(29);

select ok(
  (select count(*)::integer
   from pg_catalog.regexp_matches(
     pg_get_functiondef(
       'public.platform_mark_company_invitation_delivery(uuid,text,text)'::regprocedure
     ), 'can_manage_platform\(\)', 'g'
   )) = 2
  and pg_catalog.strpos(
    pg_get_functiondef(
      'public.platform_mark_company_invitation_delivery(uuid,text,text)'::regprocedure
    ), 'enforce_mfa_for_privileged()'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef(
      'public.platform_mark_company_invitation_delivery(uuid,text,text)'::regprocedure
    ), 'v_expires_at'
  ) > 0,
  'delivery conserva MFA, revalidación y verifica expiración bajo lock'
);
select ok(
  (select count(*)::integer
   from pg_catalog.regexp_matches(
     pg_get_functiondef(
       'public.platform_set_onboarding_step_completed(uuid,text,boolean)'::regprocedure
     ), 'can_manage_platform\(\)', 'g'
   )) = 2
  and pg_catalog.strpos(
    pg_get_functiondef(
      'public.platform_set_onboarding_step_completed(uuid,text,boolean)'::regprocedure
    ), 'if v_previous_status = v_next_status then'
  ) > 0,
  'onboarding conserva revalidación y declara el no-op explícito'
);
select ok(
  (select count(*)::integer
   from pg_catalog.regexp_matches(
     pg_get_functiondef(
       'public.platform_set_company_module_status(uuid,text,company_module_status)'::regprocedure
     ), 'can_manage_platform\(\)', 'g'
   )) = 2
  and pg_catalog.strpos(
    pg_get_functiondef(
      'public.platform_set_company_module_status(uuid,text,company_module_status)'::regprocedure
    ), 'then cm.enabled_at'
  ) > 0
  and pg_catalog.strpos(
    pg_get_functiondef(
      'public.platform_set_company_module_status(uuid,text,company_module_status)'::regprocedure
    ), 'for update of cm, mc, c'
  ) > 0,
  'módulos bloquean empresa, catálogo y entitlement, revalidan y conservan enabled_at'
);
select has_trigger(
  'public', 'onboarding_step_catalog',
  'onboarding_step_catalog_provision_companies',
  'el catálogo propaga pasos activos nuevos a empresas existentes'
);
select ok(
  not exists (
    select 1
    from public.companies c
    cross join public.onboarding_step_catalog osc
    left join public.company_onboarding_steps cos
      on cos.company_id = c.id and cos.step_key = osc.key
    where osc.active and cos.company_id is null
  ),
  'el backfill cubre todos los pasos activos para todas las empresas existentes'
);

insert into public.companies (
  id, name, legal_name, slug, active, status, workspace_enabled
) values (
  '87000000-0000-4000-8000-000000000001',
  'Transiciones 087', 'Transiciones 087 SpA', 'transiciones-087',
  true, 'ONBOARDING', false
);
insert into public.profiles (id, display_name, role, active)
values (
  '87000000-0000-4000-8000-000000000101',
  'Owner Transiciones 087', null, true
);
insert into public.platform_memberships (user_id, role, active)
values ('87000000-0000-4000-8000-000000000101', 'OWNER', true);

insert into public.onboarding_step_catalog (
  key, name, description, sort_order, active
) values (
  'evidence_087', 'Evidencia 087',
  'Paso agregado después de que las empresas ya existen.', 75, true
);
select is(
  (select count(*)::integer
   from public.company_onboarding_steps
   where step_key = 'evidence_087'),
  (select count(*)::integer from public.companies),
  'un paso activo nuevo se provisiona una vez en cada empresa existente'
);

insert into public.company_invitations (
  id, company_id, email, role_id, status, expires_at, invited_by
)
select
  '87000000-0000-4000-8000-000000000201',
  '87000000-0000-4000-8000-000000000001',
  'expirada-087@example.test', cr.id, 'PENDING',
  pg_catalog.now() - interval '1 minute',
  '87000000-0000-4000-8000-000000000101'
from public.company_roles cr
where cr.company_id = '87000000-0000-4000-8000-000000000001'
  and cr.code = 'AUDITOR';
insert into public.company_invitations (
  id, company_id, email, role_id, status, expires_at, invited_by
)
select
  '87000000-0000-4000-8000-000000000202',
  '87000000-0000-4000-8000-000000000001',
  'vigente-087@example.test', cr.id, 'PENDING',
  pg_catalog.now() + interval '1 day',
  '87000000-0000-4000-8000-000000000101'
from public.company_roles cr
where cr.company_id = '87000000-0000-4000-8000-000000000001'
  and cr.code = 'AUDITOR';

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select throws_ok(
  $$select public.platform_mark_company_invitation_delivery(
    '87000000-0000-4000-8000-000000000201', 'SENT', 'NO-DEBE-PERSISTIR'
  )$$,
  '23514', 'La invitación pendiente está expirada.',
  'una invitación expirada no admite estado de entrega'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select delivery_status = 'PENDING' and delivery_attempts = 0
          and last_delivery_at is null and delivery_error_code is null
   from public.company_invitations
   where id = '87000000-0000-4000-8000-000000000201'),
  'rechazar la invitación expirada no muta sus metadatos de entrega'
);
select is(
  (select count(*)::integer from public.platform_audit_log
   where target_id = '87000000-0000-4000-8000-000000000201'
     and action = 'company.invitation.delivery_attempted'),
  0,
  'rechazar la invitación expirada no genera auditoría'
);

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  $$select public.platform_mark_company_invitation_delivery(
    '87000000-0000-4000-8000-000000000202', 'SENT', 'SECRETO-087'
  )$$,
  'una invitación vigente sí registra el resultado de entrega'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select delivery_status = 'SENT' and delivery_attempts = 1
          and last_delivery_at is not null and delivery_error_code is null
   from public.company_invitations
   where id = '87000000-0000-4000-8000-000000000202'),
  'SENT persiste sin guardar el código de error recibido'
);
select ok(
  (select not (metadata ? 'error_code')
          and metadata::text not like '%SECRETO-087%'
   from public.platform_audit_log
   where target_id = '87000000-0000-4000-8000-000000000202'
     and action = 'company.invitation.delivery_attempted'),
  'la auditoría SENT no filtra error_code ni su valor'
);

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  $$select public.platform_set_onboarding_step_completed(
    '87000000-0000-4000-8000-000000000001', 'company_profile', true
  )$$,
  'la primera transición de onboarding se aplica'
);
reset role;
set local request.jwt.claims = '';
update public.company_onboarding_steps
set notes = 'evidencia estable 087'
where company_id = '87000000-0000-4000-8000-000000000001'
  and step_key = 'company_profile';
create temporary table onboarding_snapshot_087 as
select completed_at, completed_by, updated_at, notes, ctid::text as tuple_id
from public.company_onboarding_steps
where company_id = '87000000-0000-4000-8000-000000000001'
  and step_key = 'company_profile';

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  $$select public.platform_set_onboarding_step_completed(
    '87000000-0000-4000-8000-000000000001', 'company_profile', true
  )$$,
  'repetir el mismo estado de onboarding es un no-op válido'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select cos.completed_at = snap.completed_at
          and cos.completed_by = snap.completed_by
          and cos.updated_at = snap.updated_at
          and cos.notes is not distinct from snap.notes
          and cos.ctid::text = snap.tuple_id
   from public.company_onboarding_steps cos
   cross join onboarding_snapshot_087 snap
   where cos.company_id = '87000000-0000-4000-8000-000000000001'
     and cos.step_key = 'company_profile'),
  'el no-op conserva timestamp, actor, updated_at y evidencia'
);
select is(
  (select count(*)::integer from public.platform_audit_log
   where company_id = '87000000-0000-4000-8000-000000000001'
     and action = 'company.onboarding_step.status_changed'
     and target_id = 'company_profile'),
  1,
  'el no-op de onboarding no duplica auditoría'
);

update public.company_modules
set status = 'PILOT',
    enabled_at = '2026-01-01 00:00:00+00'::timestamptz,
    enabled_by = '87000000-0000-4000-8000-000000000101'
where company_id = '87000000-0000-4000-8000-000000000001'
  and module_key = 'expenses';

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  $$select public.platform_set_company_module_status(
    '87000000-0000-4000-8000-000000000001', 'expenses', 'ENABLED'
  )$$,
  'PILOT puede converger a ENABLED'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select status = 'ENABLED'
          and enabled_at = '2026-01-01 00:00:00+00'::timestamptz
   from public.company_modules
   where company_id = '87000000-0000-4000-8000-000000000001'
     and module_key = 'expenses')
  and (select count(*) = 1
       from public.platform_audit_log
       where company_id = '87000000-0000-4000-8000-000000000001'
         and action = 'company.module.status_changed'
         and target_id = 'expenses'),
  'PILOT->ENABLED preserva enabled_at y audita una transición'
);
create temporary table module_snapshot_087 as
select updated_at, enabled_at, ctid::text as tuple_id
from public.company_modules
where company_id = '87000000-0000-4000-8000-000000000001'
  and module_key = 'expenses';

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  $$select public.platform_set_company_module_status(
    '87000000-0000-4000-8000-000000000001', 'expenses', 'ENABLED'
  )$$,
  'repetir ENABLED es un no-op válido'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select cm.updated_at = snap.updated_at
          and cm.enabled_at = snap.enabled_at
          and cm.ctid::text = snap.tuple_id
   from public.company_modules cm
   cross join module_snapshot_087 snap
   where cm.company_id = '87000000-0000-4000-8000-000000000001'
     and cm.module_key = 'expenses')
  and (select count(*) = 1
       from public.platform_audit_log
       where company_id = '87000000-0000-4000-8000-000000000001'
         and action = 'company.module.status_changed'
         and target_id = 'expenses'),
  'el no-op de módulo no toca timestamps ni duplica auditoría'
);

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  $$select public.platform_set_company_module_status(
    '87000000-0000-4000-8000-000000000001', 'expenses', 'PILOT'
  )$$,
  'ENABLED puede volver a PILOT'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select status = 'PILOT'
          and enabled_at = '2026-01-01 00:00:00+00'::timestamptz
   from public.company_modules
   where company_id = '87000000-0000-4000-8000-000000000001'
     and module_key = 'expenses')
  and (select count(*) = 2
       from public.platform_audit_log
       where company_id = '87000000-0000-4000-8000-000000000001'
         and action = 'company.module.status_changed'
         and target_id = 'expenses'),
  'ENABLED->PILOT también preserva enabled_at y audita solo el cambio'
);

update public.company_onboarding_steps
set status = 'COMPLETE',
    completed_at = pg_catalog.clock_timestamp(),
    completed_by = '87000000-0000-4000-8000-000000000101'
where company_id = '87000000-0000-4000-8000-000000000001'
  and step_key = 'go_live';
update public.companies
set status = 'ACTIVE'
where id = '87000000-0000-4000-8000-000000000001';

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select throws_ok(
  $$select public.platform_set_company_module_status(
    '87000000-0000-4000-8000-000000000001', 'expenses', 'DISABLED'
  )$$,
  '23514', 'Reabre go_live antes de desactivar el último módulo multiempresa.',
  'go_live completo impide retirar el último módulo aislado activo'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select status = 'PILOT'
   from public.company_modules
   where company_id = '87000000-0000-4000-8000-000000000001'
     and module_key = 'expenses')
  and (select count(*) = 2
       from public.platform_audit_log
       where company_id = '87000000-0000-4000-8000-000000000001'
         and action = 'company.module.status_changed'
         and target_id = 'expenses'),
  'el rechazo conserva el módulo y no genera auditoría parcial'
);

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  $$select public.platform_set_onboarding_step_completed(
    '87000000-0000-4000-8000-000000000001', 'go_live', false
  )$$,
  'go_live puede reabrirse antes de retirar el último módulo'
);
select lives_ok(
  $$select public.platform_set_company_module_status(
    '87000000-0000-4000-8000-000000000001', 'expenses', 'DISABLED'
  )$$,
  'con go_live reabierto se puede retirar el último módulo aislado'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select status = 'DISABLED'
   from public.company_modules
   where company_id = '87000000-0000-4000-8000-000000000001'
     and module_key = 'expenses')
  and (select count(*) = 3
       from public.platform_audit_log
       where company_id = '87000000-0000-4000-8000-000000000001'
         and action = 'company.module.status_changed'
         and target_id = 'expenses'),
  'reabrir go_live libera la transición y deja una sola auditoría adicional'
);

update public.company_modules
set status = 'PILOT',
    enabled_at = '2026-01-01 00:00:00+00'::timestamptz,
    enabled_by = '87000000-0000-4000-8000-000000000101'
where company_id = '0a4c0000-0000-0000-0000-000000000001'
  and module_key = 'expenses';
update public.company_onboarding_steps
set status = 'COMPLETE',
    completed_at = pg_catalog.clock_timestamp(),
    completed_by = '87000000-0000-4000-8000-000000000101'
where company_id = '0a4c0000-0000-0000-0000-000000000001'
  and step_key = 'go_live';

set local role authenticated;
set local request.jwt.claim.sub = '87000000-0000-4000-8000-000000000101';
set local request.jwt.claim.aal = 'aal2';
set local request.jwt.claims = '{"sub":"87000000-0000-4000-8000-000000000101","aal":"aal2"}';
select lives_ok(
  $$select public.platform_set_company_module_status(
    '0a4c0000-0000-0000-0000-000000000001', 'expenses', 'DISABLED'
  )$$,
  'el workspace laboral de Arcotex permite retirar el último módulo multiempresa'
);
reset role;
set local request.jwt.claims = '';
select ok(
  (select cm.status = 'DISABLED' and c.workspace_enabled
   from public.company_modules cm
   join public.companies c on c.id = cm.company_id
   where cm.company_id = '0a4c0000-0000-0000-0000-000000000001'
     and cm.module_key = 'expenses')
  and (select count(*) = 1
       from public.platform_audit_log
       where actor_id = '87000000-0000-4000-8000-000000000101'
         and company_id = '0a4c0000-0000-0000-0000-000000000001'
         and action = 'company.module.status_changed'
         and target_id = 'expenses'),
  'Arcotex workspace_enabled=true queda fuera del bloqueo y audita la transición'
);

select * from finish();
rollback;
