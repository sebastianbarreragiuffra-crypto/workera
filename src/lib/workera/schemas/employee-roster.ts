import { z } from "zod";

/**
 * Valida la forma REAL (confirmada, Pre-Fase-8) de la respuesta de
 * GET /employee -- endpoint distinto y más rico que el sub-objeto `employee`
 * embebido en GET /attendanceData (confirmado ya en Fase 5C, ver
 * docs/WORKERA_REAL_CONNECTION_PHASE5C.md línea 58: "EmployeeFullData,
 * distinto del sub-objeto reducido de attendanceData").
 *
 * Hallazgo real (investigación read-only de esta fase, no asumido):
 * `branchOffice`/`department` NO son requeridos -- sin ningún parámetro,
 * `GET /employee` devuelve el roster COMPLETO paginado (confirmado: 97
 * resultados, 10 páginas). Cuando SÍ se envían, deben ser los CÓDIGOS
 * (`branchOfficeCode`/`departmentCode`, ej. "MATRIZ"/"PRODUCCION"), nunca
 * los nombres visibles (ej. "Matriz"/"DEPARTAMENTO DE PRODUCCION" no
 * filtran nada -- probado, devuelve 0 resultados).
 *
 * El payload real trae campos de PII sensible (identification=RUT,
 * birthDate, address, personalPhone, personalMail, corporateMail,
 * corporatePhone, civilStatus, genre, nationality) que este schema valida
 * (para no fallar la respuesta completa por un campo inesperado) pero que
 * el mapper (mappers/employee-roster.ts) NUNCA traslada al DTO normalizado
 * -- minimización de datos, mismo criterio ya aplicado a `employees.rut`
 * desde Fase 6A.
 */
const rawWorkeraEmployeeRosterEntrySchema = z
  .object({
    code: z.string().min(1, "code no puede ser vacío"),
    deviceCode: z.union([z.number(), z.string()]).nullish(),
    identification: z.string().nullish(),
    name: z.string().nullish(),
    secondName: z.string().nullish(),
    lastName: z.string().nullish(),
    secondLastName: z.string().nullish(),
    branchOfficeCode: z.string().nullish(),
    branchOfficeName: z.string().nullish(),
    departmentCode: z.string().nullish(),
    departmentName: z.string().nullish(),
    employeeStatus: z.string().nullish(),
  })
  // Otros campos reales confirmados (birthDate, address, personalPhone,
  // personalMail, corporateMail, corporatePhone, civilStatus, genre,
  // nationality, costCenterCode/Name, favorite, comment) se dejan pasar sin
  // validar estrictamente -- no se usan, no vale la pena que un formato
  // inesperado en un campo irrelevante tumbe la respuesta completa.
  .passthrough();

export const rawWorkeraEmployeeRosterResponseSchema = z.object({
  page: z.number().int().min(1),
  totalPages: z.number().int().min(0),
  pageResult: z.number().int().min(0),
  totalResult: z.number().int().min(0),
  requestInfo: z.unknown().optional(),
  data: z.array(rawWorkeraEmployeeRosterEntrySchema),
});

export type RawWorkeraEmployeeRosterEntryParsed = z.infer<typeof rawWorkeraEmployeeRosterEntrySchema>;
export type RawWorkeraEmployeeRosterResponseParsed = z.infer<typeof rawWorkeraEmployeeRosterResponseSchema>;
