-- Asistencia: identidad local provisional autorizada para una persona real
-- que aún no dispone de RUT/código Workera. La clave técnica mantiene el
-- NOT NULL histórico de external_workera_id, pero usa el prefijo reservado
-- LOCAL-PROVISIONAL: y nunca debe presentarse como código Workera real.
--
-- Esta fuente es reconciliable: al obtener el identificador oficial, la misma
-- fila se promueve a source='workera'. No representa datos ficticios/demo.

alter table public.employees
  drop constraint employees_source_check,
  add constraint employees_source_check
    check (source in ('workera', 'excel_roster', 'demo', 'local_provisional')),
  add constraint employees_local_provisional_code_chk
    check ((source = 'local_provisional') = (external_workera_id like 'LOCAL-PROVISIONAL:%'));

comment on column public.employees.source is
  'Origen de identidad: workera (oficial), excel_roster (administrativo), '
  'demo (sintético) o local_provisional (persona real autorizada aún sin '
  'identificador oficial; debe reconciliarse promoviendo la misma fila).';

comment on constraint employees_local_provisional_code_chk on public.employees is
  'Separa inequívocamente las claves técnicas LOCAL-PROVISIONAL de los códigos Workera oficiales.';
