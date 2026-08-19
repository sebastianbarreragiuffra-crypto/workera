/**
 * Tipos REALES del endpoint GET /attendanceData, confirmados contra el
 * manual oficial de Workera (Fase 5C) — a diferencia de `types/raw.ts`
 * (que sigue siendo un placeholder especulativo para employee/absence, sin
 * confirmar todavía), esta forma tiene respaldo documental real.
 *
 * Workera entrega EVENTOS individuales de marcación (entrada, salida,
 * inicio/término de descanso, salidas/entradas extraordinarias) — NO un par
 * clock_in/clock_out ya resuelto. Este adapter conserva el evento tal como
 * llega; colapsar eventos en un clock-in/clock-out definitivo por
 * trabajador+día es responsabilidad de una futura capa de
 * sincronización/reglas de negocio, deliberadamente fuera de alcance aquí
 * (Fase 5C, regla 16 del encargo).
 */

export const WORKERA_ATTENDANCE_TYPES = {
  0: "ENTRADA",
  1: "SALIDA",
  2: "SALIDA_EXTRAORDINARIA",
  3: "ENTRADA_EXTRAORDINARIA",
  4: "INICIO_DESCANSO",
  5: "TERMINO_DESCANSO",
} as const;

export type WorkeraAttendanceTypeCode = keyof typeof WORKERA_ATTENDANCE_TYPES;
export type WorkeraAttendanceTypeLabel =
  | (typeof WORKERA_ATTENDANCE_TYPES)[WorkeraAttendanceTypeCode]
  | "UNKNOWN_EXTERNAL_TYPE";

/** Los 3 valores documentados de attendanceStatus. Cualquier otro valor se conserva como UNKNOWN_EXTERNAL_STATUS, nunca se descarta el original (ver externalAttendanceStatus). */
export type WorkeraAttendanceStatus = "ACTIVO" | "INACTIVO" | "MODIFICADO" | "UNKNOWN_EXTERNAL_STATUS";

/**
 * Objeto `employee` embebido dentro de cada evento de /attendanceData — NO
 * es la misma forma que el `EmployeeFullData` de GET /employee (menos
 * campos, sin datos personales como fecha de nacimiento/dirección).
 */
export interface RawWorkeraAttendanceEmployee {
  code: string;
  deviceCode?: number | string | null;
  identification?: string | null;
  name?: string | null;
  lastName?: string | null;
  branchOffice?: string | null;
  department?: string | null;
  employeeStatus?: string | null;
  companyIdentification?: string | null;
  companyName?: string | null;
}

export interface RawWorkeraAttendanceEvent {
  employee: RawWorkeraAttendanceEmployee;
  /** Formato documentado: yyyy-MM-dd'T'HH:mm:ss. El manual NO demuestra offset/UTC — ver mappers/attendance-event.ts. */
  attendanceDate: string;
  attendanceType: number;
  attendanceStatus: string;
  origin?: string | null;
  originCode?: string | null;
  address?: string | null;
  deviceName?: string | null;
  checksum?: string | null;
  isMobile?: boolean | null;
  coordinatesMobile?: unknown;
  precision?: unknown;
}

export interface RawWorkeraAttendanceDataResponse {
  page: number;
  totalPages: number;
  pageResult: number;
  totalResult: number;
  requestInfo?: unknown;
  data: RawWorkeraAttendanceEvent[];
}

/**
 * Sub-objeto `employee` normalizado, tal como viene embebido en cada evento
 * de `/attendanceData` — NO es la forma completa de `GET /employee`
 * (`EmployeeFullData`, sin fecha de nacimiento/dirección/teléfono/email
 * aquí). Se conserva solo lo necesario para: (a) resolver identidad interna
 * (`code`), (b) descubrir valores de sucursal/departamento (Fase 6A, PASO
 * 11), (c) poblar los campos mínimos ya existentes de `employees` (Fase 2).
 * `identification` (RUT/pasaporte) se conserva en el DTO normalizado por
 * completitud del contrato, pero el pipeline de ingesta de Fase 6A NO lo
 * persiste en Supabase (minimización de datos, PASO 9/30 del encargo).
 */
export interface NormalizedWorkeraAttendanceEmployee {
  code: string;
  identification: string | null;
  name: string | null;
  lastName: string | null;
  branchOffice: string | null;
  department: string | null;
  employeeStatus: string | null;
  companyIdentification: string | null;
  companyName: string | null;
}

/**
 * Normalizado a nivel de EVENTO — deliberadamente NO colapsa a
 * clock_in/clock_out (regla 16, Fase 5C). `attendanceTimestampRaw` conserva
 * el valor exacto entregado por Workera sin conversión de timezone: el
 * formato documentado no demuestra offset UTC, así que asumir uno sería
 * inventar un dato no confirmado (ver docs/WORKERA_REAL_CONNECTION_PHASE5C.md).
 */
export interface NormalizedWorkeraAttendanceEvent {
  employeeExternalId: string;
  /** Detalle completo del empleado embebido en este evento — ver NormalizedWorkeraAttendanceEmployee. */
  employee: NormalizedWorkeraAttendanceEmployee;
  attendanceTimestampRaw: string;
  attendanceTypeCode: number;
  attendanceTypeLabel: WorkeraAttendanceTypeLabel;
  attendanceStatus: WorkeraAttendanceStatus;
  /** Valor crudo de Workera para diagnóstico cuando attendanceStatus === "UNKNOWN_EXTERNAL_STATUS". */
  externalAttendanceStatus: string;
  origin: string | null;
  originCode: string | null;
  deviceName: string | null;
  checksum: string | null;
}

export interface NormalizedWorkeraAttendancePage {
  page: number;
  totalPages: number;
  pageResult: number;
  totalResult: number;
  events: NormalizedWorkeraAttendanceEvent[];
}
