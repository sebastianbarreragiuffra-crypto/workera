-- pgTAP Fase 3: protección de audit_log — insertable solo con el actor real,
-- nunca editable ni borrable (secciones 36/37 del encargo)
create extension if not exists pgtap;

begin;
select plan(5);

insert into public.profiles (id, display_name, role) values
  ('34000000-0000-0000-0000-000000000001', 'Fixture Admin Audit', 'ADMIN_RRHH'),
  ('34000000-0000-0000-0000-000000000002', 'Fixture Supervisor Audit', 'SUPERVISOR_PRODUCTION');

-- 1) Un supervisor puede insertar un evento de auditoría atribuido A SÍ MISMO.
set local role authenticated;
set local request.jwt.claim.sub = '34000000-0000-0000-0000-000000000002';

select lives_ok(
  format(
    $$ insert into public.audit_log (actor_id, action, entity_type, entity_id)
       values (%L, 'overtime_decision.created', 'overtime_decisions', gen_random_uuid()) $$,
    '34000000-0000-0000-0000-000000000002'
  ),
  'un usuario autenticado puede insertar audit_log atribuido a sí mismo'
);

-- 2) NO puede insertar un evento fingiendo que el actor fue otro usuario.
select throws_ok(
  format(
    $$ insert into public.audit_log (actor_id, action, entity_type, entity_id)
       values (%L, 'overtime_decision.created', 'overtime_decisions', gen_random_uuid()) $$,
    '34000000-0000-0000-0000-000000000001' -- fingiendo ser el admin
  ),
  '42501',
  null,
  'un usuario no puede insertar audit_log fingiendo ser otro actor'
);

-- 3) Un supervisor tiene GRANT de SELECT (necesario para insertar sus propios
-- eventos), pero la policy de lectura es admin-only: no ve ninguna fila,
-- incluida la que él mismo insertó en el paso 1.
select is_empty(
  $$ select 1 from public.audit_log $$,
  'SUPERVISOR_PRODUCTION no ve ninguna fila de audit_log (SELECT restringido a ADMIN_RRHH)'
);

reset role;

-- 4) Ni siquiera ADMIN_RRHH puede modificar una entrada de auditoría ya
-- escrita (trigger de inmutabilidad, además de la ausencia de policy UPDATE).
set local role authenticated;
set local request.jwt.claim.sub = '34000000-0000-0000-0000-000000000001';

select throws_ok(
  $$ update public.audit_log set action = 'tampered' $$,
  '42501',
  null,
  'ADMIN_RRHH no puede modificar audit_log (sin policy de UPDATE)'
);

-- 5) Ni borrarla.
select throws_ok(
  $$ delete from public.audit_log $$,
  '42501',
  null,
  'ADMIN_RRHH no puede borrar audit_log (sin policy de DELETE)'
);

reset role;
select * from finish();
rollback;
