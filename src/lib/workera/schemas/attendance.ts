import { z } from "zod";

/** Valida que el string sea una fecha/hora parseable — no asumimos un formato exacto de Workera, solo que debe ser interpretable como instante. */
const parseableTimestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "no es un timestamp interpretable",
  });

/**
 * Valida la forma de types/raw.ts#RawWorkeraAttendanceRecord. Especulativa —
 * ver la advertencia en ese archivo.
 */
export const rawWorkeraAttendanceRecordSchema = z.object({
  employee_id: z.string().min(1, "employee_id no puede ser vacío"),
  date: z.string().min(1, "date no puede ser vacío"),
  clock_in: parseableTimestamp.nullish(),
  clock_out: parseableTimestamp.nullish(),
  record_id: z.string().nullish(),
  updated_at: parseableTimestamp.nullish(),
  status_code: z.string().nullish(),
});

export const rawWorkeraAttendanceListSchema = z.array(rawWorkeraAttendanceRecordSchema);
