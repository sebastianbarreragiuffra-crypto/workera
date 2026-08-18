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

const rawWorkeraAttendanceEventSchema = z.object({
  employee: rawWorkeraAttendanceEmployeeSchema,
  attendanceDate: z.string().min(1, "attendanceDate no puede ser vacío"),
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
