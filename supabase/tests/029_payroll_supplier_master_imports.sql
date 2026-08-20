-- pgTAP: reemplazo seguro del maestro de proveedores (Nómina de Pago).
-- Cubre: RUT normalizado como identificador canónico (único solo entre
-- activos), exactamente un import ACTIVE a la vez, RLS (solo
-- SUPER_ADMIN/ADMIN_RRHH), y que el bucket de Storage sea privado.
create extension if not exists pgtap;

begin;
select plan(18);

-- ---------------------------------------------------------------------------
-- Fixtures
insert into public.profiles (id, display_name, role) values
  ('99000000-0000-0000-0000-000000000001', 'Fixture RRHH Nómina', 'ADMIN_RRHH'),
  ('99000000-0000-0000-0000-000000000002', 'Fixture Supervisor Prod Nómina', 'SUPERVISOR_PRODUCTION');

-- ---------------------------------------------------------------------------
-- 1) normalized_rut único solo entre proveedores ACTIVOS
insert into public.suppliers (rut, name, normalized_name, normalized_rut, payment_method, bank_code, account_number, created_by)
values ('11111111-1', 'PROVEEDOR FIXTURE UNO', 'PROVEEDOR FIXTURE UNO', '111111111', 'OTC', '1', '999', '99000000-0000-0000-0000-000000000001');

select throws_ok(
  $$ insert into public.suppliers (rut, name, normalized_name, normalized_rut, payment_method, bank_code, account_number, created_by)
     values ('11.111.111-1', 'PROVEEDOR FIXTURE UNO DUPLICADO', 'PROVEEDOR FIXTURE UNO DUPLICADO', '111111111', 'OTC', '1', '888', '99000000-0000-0000-0000-000000000001') $$,
  '23505',
  null,
  'un segundo proveedor ACTIVO con el mismo RUT normalizado es rechazado, aunque el nombre sea distinto'
);

select lives_ok(
  $$ update public.suppliers set active = false where normalized_rut = '111111111' $$,
  'desactivar el proveedor original (nunca borrarlo) libera su RUT para un reemplazo'
);

select lives_ok(
  $$ insert into public.suppliers (rut, name, normalized_name, normalized_rut, payment_method, bank_code, account_number, created_by)
     values ('11.111.111-1', 'PROVEEDOR FIXTURE UNO ACTUALIZADO', 'PROVEEDOR FIXTURE UNO ACTUALIZADO', '111111111', 'OTC', '1', '777', '99000000-0000-0000-0000-000000000001') $$,
  'con el original desactivado, el mismo RUT normalizado puede volver a estar ACTIVO en una fila nueva'
);

select is(
  (select count(*)::int from public.suppliers where normalized_rut = '111111111'),
  2,
  'el proveedor original desactivado NUNCA se borró -- sigue existiendo (historial preservado)'
);

-- ---------------------------------------------------------------------------
-- 2) supplier_master_imports: exactamente un ACTIVE a la vez
select lives_ok(
  $$ insert into public.supplier_master_imports (id, uploaded_by, original_filename, file_size, row_count, status, activated_at)
     values ('99000000-0000-0000-0000-0000000000a1', '99000000-0000-0000-0000-000000000001', 'fixture.xlsx', 1000, 10, 'ACTIVE', now()) $$,
  'primer import ACTIVE se acepta'
);

select throws_ok(
  $$ insert into public.supplier_master_imports (id, uploaded_by, original_filename, file_size, row_count, status, activated_at)
     values ('99000000-0000-0000-0000-0000000000a2', '99000000-0000-0000-0000-000000000001', 'fixture2.xlsx', 1000, 10, 'ACTIVE', now()) $$,
  '23505',
  null,
  'un segundo import ACTIVE simultáneo es rechazado (índice único parcial, exactamente un maestro activo)'
);

select lives_ok(
  $$ update public.supplier_master_imports set status = 'REPLACED', replaced_at = now() where id = '99000000-0000-0000-0000-0000000000a1' $$,
  'marcar el import anterior como REPLACED (nunca se borra la fila) libera el estado ACTIVE'
);

select lives_ok(
  $$ insert into public.supplier_master_imports (id, uploaded_by, original_filename, file_size, row_count, status, activated_at, replaces_import_id)
     values ('99000000-0000-0000-0000-0000000000a2', '99000000-0000-0000-0000-000000000001', 'fixture2.xlsx', 1000, 10, 'ACTIVE', now(), '99000000-0000-0000-0000-0000000000a1') $$,
  'con el anterior REPLACED, un nuevo import ACTIVE que lo referencia (replaces_import_id) es aceptado'
);

-- ---------------------------------------------------------------------------
-- 3) check constraints: activated_at/replaced_at coherentes con status
select throws_ok(
  $$ insert into public.supplier_master_imports (uploaded_by, original_filename, file_size, row_count, status, activated_at)
     values ('99000000-0000-0000-0000-000000000001', 'sin-activar.xlsx', 100, 1, 'READY', now()) $$,
  '23514',
  null,
  'activated_at solo puede estar seteado si status es ACTIVE/REPLACED'
);

-- ---------------------------------------------------------------------------
-- 4) apply_supplier_master_import: persistencia + activación en UNA transacción
--    real (encontrado al verificar con datos reales: dos pasos separados podían
--    dejar `suppliers` mutado con el archivo nuevo mientras el import "activo"
--    seguía siendo el viejo -- ver comentario en la migración 2b).
select lives_ok(
  $$ select public.apply_supplier_master_import(
       '99000000-0000-0000-0000-0000000000b1'::uuid,
       '99000000-0000-0000-0000-000000000001'::uuid,
       'maestro-nuevo.xlsx', 'some/path.xlsx', 1000, 1, 1, 0, 0, 0,
       '[{"rut":"33333333-3","name":"PROVEEDOR ATOMICO","normalized_name":"PROVEEDOR ATOMICO","normalized_rut":"333333333","payment_method":"OTC","bank_code":"1","account_number":"555"}]'::jsonb,
       '[]'::jsonb
     ) $$,
  'apply_supplier_master_import inserta el proveedor nuevo, registra el import y lo activa en una sola llamada'
);

select is(
  (select status::text from public.supplier_master_imports where id = '99000000-0000-0000-0000-0000000000a2'),
  'REPLACED',
  'el import ACTIVE anterior queda REPLACED automáticamente al activar el nuevo (mismo llamado atómico)'
);

select is(
  (select status::text from public.supplier_master_imports where id = '99000000-0000-0000-0000-0000000000b1'),
  'ACTIVE',
  'el import nuevo queda ACTIVE tras la llamada'
);

-- Fuerza una violación real (dos filas del mismo lote con el mismo RUT activo simultáneamente)
-- para probar que TODO se revierte -- ni el import nuevo ni el reemplazo del anterior quedan a medias.
select throws_ok(
  $$ select public.apply_supplier_master_import(
       '99000000-0000-0000-0000-0000000000b2'::uuid,
       '99000000-0000-0000-0000-000000000001'::uuid,
       'maestro-roto.xlsx', 'some/other-path.xlsx', 1000, 2, 2, 0, 0, 0,
       '[{"rut":"44444444-4","name":"PROVEEDOR ROTO A","normalized_name":"PROVEEDOR ROTO A","normalized_rut":"444444444","payment_method":"OTC","bank_code":"1","account_number":"1"},
         {"rut":"44.444.444-4","name":"PROVEEDOR ROTO B","normalized_name":"PROVEEDOR ROTO B","normalized_rut":"444444444","payment_method":"OTC","bank_code":"1","account_number":"2"}]'::jsonb,
       '[]'::jsonb
     ) $$,
  '23505',
  null,
  'si la persistencia falla a mitad de camino (RUT activo duplicado), TODA la función se revierte'
);

select is(
  (select count(*)::int from public.supplier_master_imports where id = '99000000-0000-0000-0000-0000000000b2'),
  0,
  'tras el rollback, el import que falló NUNCA quedó registrado (ni siquiera como IMPORTING)'
);

select is(
  (select status::text from public.supplier_master_imports where id = '99000000-0000-0000-0000-0000000000b1'),
  'ACTIVE',
  'tras el rollback, el maestro que SÍ estaba activo sigue activo sin cambios parciales'
);

-- ---------------------------------------------------------------------------
-- 5) RLS: SUPERVISOR_PRODUCTION no puede leer ni escribir el maestro de proveedores
set local role authenticated;
set local request.jwt.claim.sub = '99000000-0000-0000-0000-000000000002';

select is(
  (select count(*)::int from public.suppliers),
  0,
  'SUPERVISOR_PRODUCTION no ve ninguna fila de suppliers (RLS)'
);

select throws_ok(
  $$ insert into public.supplier_master_imports (uploaded_by, original_filename, file_size, row_count, status)
     values ('99000000-0000-0000-0000-000000000002', 'no-deberia.xlsx', 100, 1, 'VALIDATING') $$,
  '42501',
  null,
  'SUPERVISOR_PRODUCTION no puede insertar en supplier_master_imports (RLS)'
);

reset role;

-- ---------------------------------------------------------------------------
-- 6) Storage: bucket privado
select is(
  (select public from storage.buckets where id = 'supplier-master-files'),
  false,
  'el bucket supplier-master-files es privado (public=false)'
);

select * from finish();
rollback;
