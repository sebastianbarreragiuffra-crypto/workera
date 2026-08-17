-- Fase 3 — 16: trazabilidad de novedades manuales en absence_records
--
-- absence_records (Fase 2A) ya soportaba source='manual', pero no guardaba
-- quién la registró — attendance_status_records (Fase 2B) sí lo hacía
-- (created_by/reason). El encargo de Fase 3 (sección 11) exige explícitamente
-- que una licencia/vacación registrada manualmente por un supervisor quede
-- con `created_by = auth.uid()`. Se agrega de forma ADITIVA (ALTER TABLE),
-- sin tocar la migración de Fase 2A: nullable, no rompe ninguna fila ni test
-- existente (los tests 2A/2B que insertan absence_records sin created_by
-- siguen funcionando sin cambios).
alter table public.absence_records
  add column created_by uuid references public.profiles(id);

comment on column public.absence_records.created_by is
  'Quién registró la novedad cuando source = manual. NULL para registros '
  'sincronizados desde Workera. La policy RLS de INSERT (migración de '
  'políticas de ausencias) exige created_by = auth.uid() cuando source = manual.';

alter table public.absence_records
  add constraint absence_records_manual_requires_actor_chk
  check (source <> 'manual' or created_by is not null);
