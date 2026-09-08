export const ARCOTEX_REPAIRABLE_ATTENDANCE_STATUSES = ["ACTIVO", "INACTIVO", "MODIFICADO"] as const;

export type ArcotexRepairableAttendanceStatus =
  (typeof ARCOTEX_REPAIRABLE_ATTENDANCE_STATUSES)[number];

export interface ArcotexAttendanceStatusRepairRow {
  readonly attendance_status: string;
  readonly external_attendance_status: string;
}

export interface ArcotexAttendanceStatusRepairPlan<Row extends ArcotexAttendanceStatusRepairRow> {
  readonly currentEvents: number;
  readonly unknownEvents: number;
  readonly unsupportedUnknownEvents: number;
  readonly alreadyNormalizedEvents: number;
  readonly targetCounts: Readonly<Record<ArcotexRepairableAttendanceStatus, number>>;
  readonly targets: ReadonlyArray<{
    readonly row: Row;
    readonly normalizedStatus: ArcotexRepairableAttendanceStatus;
  }>;
}

const REPAIRABLE_STATUS_SET: ReadonlySet<string> = new Set(
  ARCOTEX_REPAIRABLE_ATTENDANCE_STATUSES,
);

export function normalizePreservedAttendanceStatus(
  value: string,
): ArcotexRepairableAttendanceStatus | null {
  const normalized = value.trim().toUpperCase();
  return REPAIRABLE_STATUS_SET.has(normalized)
    ? (normalized as ArcotexRepairableAttendanceStatus)
    : null;
}

/**
 * Construye un plan sin mutaciones ni PII. Solo repara filas cuyo valor
 * interno quedó UNKNOWN aunque el valor crudo preservado sea uno de los tres
 * estados documentados por Workera.
 */
export function buildArcotexAttendanceStatusRepairPlan<
  Row extends ArcotexAttendanceStatusRepairRow,
>(rows: readonly Row[]): ArcotexAttendanceStatusRepairPlan<Row> {
  const targets: Array<{
    row: Row;
    normalizedStatus: ArcotexRepairableAttendanceStatus;
  }> = [];
  const targetCounts: Record<ArcotexRepairableAttendanceStatus, number> = {
    ACTIVO: 0,
    INACTIVO: 0,
    MODIFICADO: 0,
  };
  let unknownEvents = 0;
  let unsupportedUnknownEvents = 0;

  for (const row of rows) {
    if (row.attendance_status !== "UNKNOWN_EXTERNAL_STATUS") continue;
    unknownEvents += 1;
    const normalizedStatus = normalizePreservedAttendanceStatus(
      row.external_attendance_status,
    );
    if (!normalizedStatus) {
      unsupportedUnknownEvents += 1;
      continue;
    }
    targetCounts[normalizedStatus] += 1;
    targets.push({ row, normalizedStatus });
  }

  return {
    currentEvents: rows.length,
    unknownEvents,
    unsupportedUnknownEvents,
    alreadyNormalizedEvents: rows.length - unknownEvents,
    targetCounts,
    targets,
  };
}

export function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
