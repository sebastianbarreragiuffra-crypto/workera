import { z } from "zod";

/**
 * Valida la forma REAL (confirmada, Fase 5C) de la respuesta de
 * GET /attendanceData. A diferencia de schemas/attendance.ts (especulativo,
 * todavía usado por MockWorkeraClient/getAttendance), este schema valida
 * contra documentación oficial real.
 *
 * Todo lo que el manual no demuestra como "siempre presente" se valida como
 * opcional/nullable — no se asume estructura no confirmada.
 */

const rawWorkeraAttendanceEmployeeSchema = z.object({
  code: z.string().min(1, "employee.code no puede ser vacío"),
  deviceCode: z.union([z.number(), z.string()]).nullish(),
  identification: z.string().nullish(),
  name: z.string().nullish(),
  lastName: z.string().nullish(),
  branchOffice: z.string().nullish(),
  department: z.string().nullish(),
  employeeStatus: z.string().nullish(),
  companyIdentification: z.string().nullish(),
  companyName: z.string().nullish(),
});

const workeraLocalTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/,
    "attendanceDate debe ser un timestamp local ISO sin zona horaria"
  )
  .refine((value) => {
    const parsed = new Date(`${value}Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
  }, "attendanceDate contiene una fecha u hora imposible");

const rawWorkeraAttendanceEventSchema = z.object({
  employee: rawWorkeraAttendanceEmployeeSchema,
  // Workera documenta hora local sin offset. Aceptar solo una fecha, un Z o
  // un offset y luego reinterpretarlo en Santiago desplazaría la marcación.
  attendanceDate: workeraLocalTimestampSchema,
  // 0-5 documentado (Entrada/Salida/Salida extraordinaria/Entrada
  // extraordinaria/Inicio descanso/Término descanso). Fuera de ese rango se
  // rechaza explícitamente — no se inventa un séptimo tipo.
  attendanceType: z.number().int().min(0).max(5),
  attendanceStatus: z.string().min(1, "attendanceStatus no puede ser vacío"),
  origin: z.string().nullish(),
  originCode: z.string().nullish(),
  address: z.string().nullish(),
  deviceName: z.string().nullish(),
  checksum: z.string().nullish(),
  isMobile: z.boolean().nullish(),
  coordinatesMobile: z.unknown().optional(),
  precision: z.unknown().optional(),
});

export const rawWorkeraAttendanceDataResponseSchema = z.object({
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
  pageResult: z.number().int().min(0),
  totalResult: z.number().int().min(0),
  requestInfo: z.unknown().optional(),
  data: z.array(rawWorkeraAttendanceEventSchema),
});

export type RawWorkeraAttendanceEventParsed = z.infer<typeof rawWorkeraAttendanceEventSchema>;
export type RawWorkeraAttendanceDataResponseParsed = z.infer<typeof rawWorkeraAttendanceDataResponseSchema>;
