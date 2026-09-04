-- pgTAP: fundación de MFA (TOTP) para cuentas privilegiadas.
--
-- Lo que se prueba acá es la mitad que vive en la base y que ninguna pantalla
-- puede sustituir: quién queda dentro del conjunto que exige segundo factor,
-- que la guarda de RPC distinga aal1 de aal2, quién puede resetear el factor
-- de otra persona, y que la bitácora no se pueda editar ni siquiera desde
-- `postgres`. Ver docs/MFA_DESIGN.md secciones 4 y 7.
create extension if not exists pgtap;

begin;
select plan(39);

-- ---------------------------------------------------------------------------
-- Fixtures: dos empresas, un OWNER de plataforma que además es miembro de la
-- empresa Alpha (para probar que compartir empresa no habilita resetearlo),
-- administradores de cada empresa y personal sin privilegios.
insert into public.companies (id, name, legal_name, slug, active, status, workspace_enabled) values
  ('96000000-0000-0000-0000-00000000000a', 'MFA Alpha', 'MFA Alpha SpA', 'mfa-alpha', true, 'ONBOARDING', false),
  ('96000000-0000-0000-0000-00000000000b', 'MFA Beta', 'MFA Beta SpA', 'mfa-beta', true, 'ONBOARDING', false);

-- `profiles.role` es hoy el rol del workspace ARCOTEX, y el trigger
-- `profiles_sync_arcotex_membership` (20260902050000) refleja automáticamente
-- toda cuenta con rol no nulo como miembro de ARCOTEX. Por eso el personal de
-- las empresas Alpha y Beta va con `role = null`: es como se ve realmente una
-- cuenta que pertenece a otra empresa y no al workspace laboral. Darles un
-- `profiles.role` los metería en ARCOTEX y la prueba de aislamiento entre
-- empresas dejaría de probar lo que dice probar.
insert into public.profiles (id, display_name, role, active) values
  ('96000000-0000-0000-0000-000000000101', 'Owner Plataforma MFA', null, true),
  ('96000000-0000-0000-0000-000000000102', 'Admin Alpha MFA', 'ADMIN_RRHH', true),
  ('96000000-0000-0000-0000-000000000103', 'Persona Alpha MFA', null, true),
  ('96000000-0000-0000-0000-000000000104', 'Persona Beta MFA', null, true),
  ('96000000-0000-0000-0000-000000000105', 'Admin Beta MFA', null, true),
  ('96000000-0000-0000-0000-000000000106', 'Admin Plataforma MFA', null, true),
  ('96000000-0000-0000-0000-000000000107', 'Admin Inactivo MFA', 'ADMIN_RRHH', false);

insert into public.platform_memberships (user_id, role, active) values
  ('96000000-0000-0000-0000-000000000101', 'OWNER', true),
  ('96000000-0000-0000-0000-000000000106', 'ADMIN', true),
  ('96000000-0000-0000-0000-000000000107', 'ADMIN', true);

insert into public.company_memberships (id, user_id, company_id, role, active) values
  ('96000000-0000-0000-0000-000000000201', '96000000-0000-0000-0000-000000000101', '96000000-0000-0000-0000-00000000000a', 'ADMIN_RRHH', true),
  ('96000000-0000-0000-0000-000000000202', '96000000-0000-0000-0000-000000000102', '96000000-0000-0000-0000-00000000000a', 'ADMIN_RRHH', true),
  ('96000000-0000-0000-0000-000000000203', '96000000-0000-0000-0000-000000000103', '96000000-0000-0000-0000-00000000000a', 'SUPERVISOR_PRODUCTION', true),
  ('96000000-0000-0000-0000-000000000204', '96000000-0000-0000-0000-000000000104', '96000000-0000-0000-0000-00000000000b', 'SUPERVISOR_PRODUCTION', true),
  ('96000000-0000-0000-0000-000000000205', '96000000-0000-0000-0000-000000000105', '96000000-0000-0000-0000-00000000000b', 'ADMIN_RRHH', true);

-- ---------------------------------------------------------------------------
-- 1. Estructura y privilegios mínimos.

select has_table('public', 'mfa_events', 'existe la bitácora de segundo factor');
select has_column('public', 'mfa_events', 'performed_by', 'la bitácora distingue quién ejecutó un reseteo ajeno');

select is(
  (
    select array_agg(g.privilege_type::text order by g.privilege_type)
    from information_schema.role_table_grants g
    where g.table_schema = 'public'
      and g.table_name = 'mfa_events'
      and g.grantee = 'authenticated'
  ),
  array['SELECT'],
  'authenticated solo puede leer la bitácora; los eventos vienen del backend confiable'
);

select ok(
  has_table_privilege('service_role', 'public.mfa_events', 'INSERT'),
  'service_role puede registrar eventos desde el límite server-only'
);

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.account_requires_mfa('96000000-0000-0000-0000-000000000103')$$,
  '42501', null,
  'la regla de quién exige MFA no se puede sondear desde una sesión de usuario'
);
reset role;

-- ---------------------------------------------------------------------------
-- 2. Quién queda dentro del conjunto que exige segundo factor.

select ok(
  public.account_requires_mfa('96000000-0000-0000-0000-000000000102'),
  'un ADMIN_RRHH del workspace exige segundo factor'
);
select ok(
  public.account_requires_mfa('96000000-0000-0000-0000-000000000101'),
  'el OWNER de plataforma exige segundo factor'
);
select ok(
  public.account_requires_mfa('96000000-0000-0000-0000-000000000106'),
  'un ADMIN de plataforma exige segundo factor'
);
select ok(
  not public.account_requires_mfa('96000000-0000-0000-0000-000000000103'),
  'una cuenta sin rol privilegiado no entra al conjunto MFA'
);
select ok(
  not public.account_requires_mfa('96000000-0000-0000-0000-000000000107'),
  'una cuenta desactivada no exige segundo factor aunque conserve membresías privilegiadas'
);
select ok(
  not public.account_requires_mfa(null),
  'una sesión sin identidad nunca se considera privilegiada'
);

-- ---------------------------------------------------------------------------
-- 3. La guarda de RPC distingue el nivel del request.

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';

select ok(not public.request_is_aal2(), 'sin claim de nivel, el request vale como aal1');

select throws_ok(
  $$select public.enforce_mfa_for_privileged()$$,
  'P0001', 'Esta operación requiere verificación de segundo factor (MFA).',
  'una cuenta privilegiada en aal1 no puede ejecutar una operación protegida'
);

set local request.jwt.claim.aal = 'aal2';
select ok(public.request_is_aal2(), 'con el claim en aal2 el request es de segundo factor');
select lives_ok(
  $$select public.enforce_mfa_for_privileged()$$,
  'la misma cuenta privilegiada pasa cuando llega en aal2'
);

-- Quien no exige MFA pasa igual: por eso la guarda es segura de agregar.
set local request.jwt.claim.aal = '';
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000103';
select lives_ok(
  $$select public.enforce_mfa_for_privileged()$$,
  'una cuenta fuera del conjunto MFA no se ve afectada por la guarda'
);

-- ---------------------------------------------------------------------------
-- 4. Lo que consulta el middleware sobre la propia sesión.

select ok(not public.session_requires_mfa(), 'una cuenta sin privilegios no es enviada a inscribir MFA');
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';
select ok(public.session_requires_mfa(), 'un ADMIN_RRHH sí es enviado a inscribir MFA');
reset role;

-- ---------------------------------------------------------------------------
-- 5. Quién puede resetear el segundo factor de otra persona.

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000101';
select ok(
  public.can_reset_mfa_for('96000000-0000-0000-0000-000000000102'),
  'el OWNER de plataforma resetea a un administrador de cualquier empresa'
);
select ok(
  not public.can_reset_mfa_for('96000000-0000-0000-0000-000000000101'),
  'ni siquiera el OWNER se resetea a sí mismo desde la aplicación'
);

set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';
select ok(
  not public.can_reset_mfa_for('96000000-0000-0000-0000-000000000103'),
  'un admin de empresa no borra factores globales aunque comparta empresa'
);
select ok(
  not public.can_reset_mfa_for('96000000-0000-0000-0000-000000000104'),
  'un admin de empresa no alcanza a alguien de otra empresa'
);
select ok(
  not public.can_reset_mfa_for('96000000-0000-0000-0000-000000000101'),
  'compartir empresa con el OWNER de plataforma no habilita resetearlo'
);
select ok(
  not public.can_reset_mfa_for('96000000-0000-0000-0000-000000000102'),
  'un admin de empresa tampoco se resetea a sí mismo'
);

set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000105';
select ok(
  not public.can_reset_mfa_for('96000000-0000-0000-0000-000000000103'),
  'el aislamiento vale en ambos sentidos: Beta tampoco alcanza a Alpha'
);

set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000103';
select ok(
  not public.can_reset_mfa_for('96000000-0000-0000-0000-000000000104'),
  'quien no administra ninguna empresa no resetea a nadie'
);

set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000107';
select ok(
  not public.can_reset_mfa_for('96000000-0000-0000-0000-000000000103'),
  'una cuenta desactivada no conserva capacidad de resetear MFA'
);
select ok(
  not public.can_read_mfa_events_for('96000000-0000-0000-0000-000000000103'),
  'una cuenta desactivada tampoco conserva lectura de la bitácora MFA'
);

-- ---------------------------------------------------------------------------
-- 6. RLS de la bitácora.

select throws_ok(
  $$insert into public.mfa_events (user_id, event_type, factor_id)
    values ('96000000-0000-0000-0000-000000000103', 'ENROLLED', 'factor-alpha-1')$$,
  '42501', null,
  'una sesión no puede fabricar sus propios eventos de segundo factor'
);
select throws_ok(
  $$insert into public.mfa_events (user_id, event_type, factor_id)
    values ('96000000-0000-0000-0000-000000000104', 'ENROLLED', 'factor-ajeno')$$,
  '42501', null,
  'nadie puede inventar eventos de segundo factor a nombre de otra persona'
);

set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';
select throws_ok(
  $$insert into public.mfa_events (user_id, event_type, performed_by)
    values ('96000000-0000-0000-0000-000000000103', 'ADMIN_RESET',
            '96000000-0000-0000-0000-000000000102')$$,
  '42501', null,
  'un admin de empresa tampoco puede insertar eventos administrativos'
);
select throws_ok(
  $$insert into public.mfa_events (user_id, event_type, performed_by)
    values ('96000000-0000-0000-0000-000000000104', 'ADMIN_RESET',
            '96000000-0000-0000-0000-000000000102')$$,
  '42501', null,
  'la misma regla que niega el reseteo cruzado niega su registro'
);

set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000103';
select is(
  (select count(*)::integer from public.mfa_events where user_id <> '96000000-0000-0000-0000-000000000103'),
  0,
  'una persona sin privilegios solo ve sus propios eventos'
);
reset role;

-- ---------------------------------------------------------------------------
-- 7. La bitácora es append-only incluso fuera de RLS.

select throws_ok(
  $$update public.mfa_events set event_type = 'VERIFY_SUCCESS'$$,
  '55000', 'mfa_events es append-only.',
  'ni siquiera postgres puede reescribir un evento de segundo factor'
);
select throws_ok(
  $$delete from public.mfa_events$$,
  '55000', 'mfa_events es append-only.',
  'ni siquiera postgres puede borrar un evento de segundo factor'
);
select throws_ok(
  $$insert into public.mfa_events (user_id, event_type, performed_by)
    values ('96000000-0000-0000-0000-000000000103', 'ENROLLED',
            '96000000-0000-0000-0000-000000000102')$$,
  '23514', null,
  'un evento propio no puede atribuirse a un administrador'
);

-- ---------------------------------------------------------------------------
-- 8. Primer corte de staging: la guarda AAL2 todavía NO está activa.
--
-- Esta rama temporal excluye deliberadamente 20260904120000. Verificamos que
-- la fundación y el hardening pueden desplegarse e inscribirse antes de que el
-- segundo corte bloquee los RPC privilegiados.

select is(
  (
    select count(*)::integer
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc like '%enforce_mfa_for_privileged()%'
      and p.proname in (
        'approve_medical_license', 'reject_medical_license',
        'platform_create_company', 'platform_assign_company_role',
        'platform_set_company_module_status', 'platform_set_onboarding_step_completed',
        'platform_create_company_invitation', 'platform_create_organization_unit'
      )
  ),
  0,
  'el primer corte todavía no activa la guarda de segundo factor en los RPC'
);

set local role authenticated;
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000106';
select lives_ok(
  $$select public.platform_create_company('MFA Gate', 'mfa-gate-alpha')$$,
  'un ADMIN de plataforma autorizado todavía opera en aal1 durante la inscripción'
);

-- El orden importa: la guarda de MFA va DESPUÉS de la de rol. Quien no está
-- autorizado debe recibir el error de autorización y no uno de MFA, que le
-- confirmaría que su rol alcanzaba y que lo único que falta es el código.
--
-- Se usa `approve_medical_license` y no un RPC de plataforma porque su guarda
-- (`is_medical_license_approver()`) devuelve false y no null para quien no lo
-- es. Las guardas de plataforma se apoyaban en `can_manage_platform()`, que
-- devolvía NULL cuando la cuenta no tenía membresía -- un hallazgo previo a
-- MFA, corregido en 20260904150000 y probado en 050, no en este archivo.
-- El recorrido completo de los RPC del control plane queda cubierto entre
-- 050 (la función central y el patrón vigente) y 051 (seis llamadas reales).
set local request.jwt.claim.aal = '';
set local request.jwt.claim.sub = '96000000-0000-0000-0000-000000000102';
select throws_ok(
  $$select public.approve_medical_license(
      '96000000-0000-0000-0000-0000000000f1', date '2026-08-20', date '2026-08-22')$$,
  'P0001', 'No autorizado para aprobar licencias médicas.',
  'a quien no está autorizado se le responde por rol, nunca por MFA'
);
reset role;

select * from finish();
rollback;
