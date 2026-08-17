import { z } from "zod";

/**
 * Valida la forma de types/raw.ts#RawWorkeraAbsenceRecord. Especulativa —
 * ver la advertencia en ese archivo. Nota de minimización de datos
 * (docs/PRE_FASE2_WORKERA_VALIDATION.md sección 10): este schema no incluye
 * ningún campo de diagnóstico/motivo médico ni lo aceptaría si Workera lo
 * enviara — se descartaría al no estar declarado.
 */
export const rawWorkeraAbsenceRecordSchema = z.object({
  employee_id: z.string().min(1, "employee_id no puede ser vacío"),
  type: z.string().min(1, "type no puede ser vacío"),
  start_date: z.string().min(1, "start_date no puede ser vacío"),
  end_date: z.string().min(1, "end_date no puede ser vacío"),
  record_id: z.string().nullish(),
});

export const rawWorkeraAbsenceListSchema = z.array(rawWorkeraAbsenceRecordSchema);
