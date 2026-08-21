-- Fase: extracción automática (asistida) de fechas de licencias médicas.
--
-- El flujo de subida deja de pedir fecha de inicio/término manuales; en su
-- lugar el sistema intenta extraerlas del propio documento
-- (`extractMedicalLicenseDates`, ver src/lib/decisions/medical-license-extraction.ts).
-- `extraction_status` registra si esa extracción fue confiable
-- (EXTRAIDO) o no (REQUIERE_REVISION) -- nunca se inventa una fecha: cuando
-- la extracción falla, `proposed_start_date`/`proposed_end_date` siguen
-- siendo NOT NULL (sin tocar esa restricción) pero se completan con un
-- placeholder de un solo día (fecha de hoy) que el aprobador SIEMPRE debe
-- corregir antes de aprobar -- exactamente el mismo mecanismo de
-- "propuesto vs. confirmado" que ya existía, ahora con una señal explícita
-- de que el valor propuesto no es confiable.
alter table public.medical_license_approvals
  add column extraction_status text
    check (extraction_status is null or extraction_status in ('EXTRAIDO', 'REQUIERE_REVISION'));

comment on column public.medical_license_approvals.extraction_status is
  'Resultado de la extracción automática asistida al subir el documento: '
  'EXTRAIDO (fechas leídas del documento con confianza) o REQUIERE_REVISION '
  '(no se pudo interpretar el documento de forma confiable -- proposed_* '
  'queda con un placeholder de un día que el aprobador debe corregir). Null '
  'para licencias subidas antes de esta fase.';
