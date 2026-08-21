-- pgTAP: fuente compartida del Excel de descuentos de Colaciones.
-- Cubre: exactamente una fila active=true a la vez; activate_colaciones_
-- discount_workbook() desactiva la anterior y activa la nueva atómicamente;
-- solo is_privileged_admin() puede leer/insertar/actualizar la tabla y el
-- bucket; un usuario no privilegiado no puede activar ni leer el archivo.
create extension if not exists pgtap;

begin;
select plan(14);

-- ---------------------------------------------------------------------------
-- Fixtures
insert into public.profiles (id, display_name, role) values
  ('99200000-0000-0000-0000-000000000001', 'Fixture SUPER_ADMIN', 'SUPER_ADMIN'),
  ('99200000-0000-0000-0000-000000000002', 'Fixture Supervisor Producción', 'SUPERVISOR_PRODUCTION');

-- ---------------------------------------------------------------------------
-- 1) Un supervisor (no privilegiado) no puede insertar ni leer la tabla de metadata.
set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000002';

select throws_ok(
  $$ insert into public.colaciones_discount_workbooks (storage_path, original_filename, file_size, checksum, uploaded_by)
     values ('x/y.xlsx', 'y.xlsx', 100, 'deadbeef', '99200000-0000-0000-0000-000000000002') $$,
  '42501',
  null,
  'un supervisor no puede insertar una fila de metadata directamente'
);

reset role;

select is(
  (select count(*)::int from public.colaciones_discount_workbooks where storage_path = 'x/y.xlsx'),
  0,
  'el intento de insert bloqueado no dejó ninguna fila (independiente de otras filas que ya existan en la tabla)'
);

-- ---------------------------------------------------------------------------
-- 2) Un supervisor no puede llamar la función de activación.
set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000002';

select throws_ok(
  $$ select public.activate_colaciones_discount_workbook(
       gen_random_uuid(), 'x/y.xlsx', 'y.xlsx', 100, 'deadbeef', '99200000-0000-0000-0000-000000000002') $$,
  '42501',
  null,
  'un supervisor no puede activar un archivo -- RLS en el INSERT interno lo bloquea'
);

reset role;

-- ---------------------------------------------------------------------------
-- 3) SUPER_ADMIN sí puede activar la primera versión.
set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000001';

select lives_ok(
  $$ select public.activate_colaciones_discount_workbook(
       '99200000-0000-0000-0000-0000000000f1', 'v1/descuento.xlsx', 'DESCUENTO DE COLACIONES.xlsx', 1000, 'hash-v1',
       '99200000-0000-0000-0000-000000000001') $$,
  'SUPER_ADMIN puede activar la primera versión'
);

select is(
  (select count(*)::int from public.colaciones_discount_workbooks where active),
  1,
  'exactamente una fila queda activa tras la primera activación'
);

select is(
  (select storage_path from public.colaciones_discount_workbooks where active),
  'v1/descuento.xlsx',
  'la fila activa apunta al storage_path correcto'
);

-- ---------------------------------------------------------------------------
-- 4) Reemplazo: activar una segunda versión desactiva la primera, nunca la borra.
select lives_ok(
  $$ select public.activate_colaciones_discount_workbook(
       '99200000-0000-0000-0000-0000000000f2', 'v2/descuento.xlsx', 'DESCUENTO DE COLACIONES.xlsx', 1200, 'hash-v2',
       '99200000-0000-0000-0000-000000000001') $$,
  'activar una segunda versión funciona'
);

reset role;

select is(
  (select count(*)::int from public.colaciones_discount_workbooks where active),
  1,
  'sigue habiendo exactamente UNA fila activa después del reemplazo -- nunca dos'
);

select is(
  (select storage_path from public.colaciones_discount_workbooks where active),
  'v2/descuento.xlsx',
  'la fila activa ahora es la versión nueva'
);

select is(
  (select active from public.colaciones_discount_workbooks where id = '99200000-0000-0000-0000-0000000000f1'),
  false,
  'la versión anterior queda inactiva, no se borra'
);

select is(
  (select count(*)::int from public.colaciones_discount_workbooks where id in ('99200000-0000-0000-0000-0000000000f1', '99200000-0000-0000-0000-0000000000f2')),
  2,
  'las dos versiones de este test siguen existiendo -- historial nunca se borra automáticamente'
);

-- ---------------------------------------------------------------------------
-- 5) Storage: solo is_privileged_admin() puede insertar/leer objetos del bucket.
set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000002'; -- supervisor

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, owner) values ('colaciones-config-files', 'v3/intruso.xlsx', '99200000-0000-0000-0000-000000000002') $$,
  '42501',
  null,
  'un supervisor no puede subir un objeto al bucket de configuración de Colaciones'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000001'; -- SUPER_ADMIN

select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner) values ('colaciones-config-files', 'v3/valido.xlsx', '99200000-0000-0000-0000-000000000001') $$,
  'un SUPER_ADMIN sí puede subir un objeto al bucket'
);

reset role;
set local role authenticated;
set local request.jwt.claim.sub = '99200000-0000-0000-0000-000000000002'; -- supervisor

select is(
  (select count(*)::int from storage.objects where bucket_id = 'colaciones-config-files'),
  0,
  'un supervisor no puede leer/listar los objetos del bucket de configuración de Colaciones'
);

reset role;

select * from finish();
rollback;
