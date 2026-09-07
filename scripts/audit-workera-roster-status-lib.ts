export interface WorkeraRosterAuditRow {
  code: string;
  employeeStatus: string | null;
}

export interface LocalRosterAuditRow {
  externalWorkeraId: string;
  source: string;
  active: boolean;
}

type SafeWorkeraStatus = "ACTIVO" | "INACTIVO" | "SIN_ESTADO" | "OTRO";

export interface WorkeraRosterStatusAudit {
  schemaVersion: 1;
  readOnly: true;
  workera: {
    records: number;
    uniqueCodes: number;
    duplicateCodeRows: number;
    contradictoryStatusCodes: number;
    recordsWithoutCode: number;
    statuses: Record<SafeWorkeraStatus, number>;
  };
  local: {
    employees: number;
    active: number;
    inactive: number;
    uniqueExternalCodes: number;
    duplicateExternalCodeRows: number;
    recordsWithoutExternalCode: number;
    sources: {
      workera: number;
      provisional: number;
      other: number;
    };
    workeraSource: {
      active: number;
      inactive: number;
    };
  };
  comparison: {
    matched: number;
    missingLocally: number;
    extraLocalWorkera: number;
    provisionals: number;
    otherLocalSources: number;
    mismatches: {
      localActiveWorkeraInactive: number;
      localInactiveWorkeraActive: number;
      unresolvedMatchedStatus: number;
    };
  };
}

const SAFE_STATUS_ORDER: SafeWorkeraStatus[] = ["ACTIVO", "INACTIVO", "SIN_ESTADO", "OTRO"];

function normalizeStatus(value: string | null): SafeWorkeraStatus {
  const normalized = value?.trim().toLocaleUpperCase("es-CL") ?? "";
  if (!normalized) return "SIN_ESTADO";
  if (normalized === "ACTIVO" || normalized === "INACTIVO") return normalized;
  return "OTRO";
}

function emptyStatusCounts(): Record<SafeWorkeraStatus, number> {
  return { ACTIVO: 0, INACTIVO: 0, SIN_ESTADO: 0, OTRO: 0 };
}

function cleanCode(value: string): string | null {
  const code = value.trim();
  return code.length > 0 ? code : null;
}

function resolveSingleValue<T>(values: readonly T[]): T | null {
  if (values.length === 0) return null;
  const unique = new Set(values);
  return unique.size === 1 ? values[0] : null;
}

/**
 * Compara dos padrones en memoria y devuelve exclusivamente conteos. El
 * resultado no conserva nombres, códigos de ficha, UUID, empresa ni valores
 * de configuración, de modo que se puede imprimir completo como evidencia
 * operativa sin exponer datos personales.
 */
export function buildWorkeraRosterStatusAudit(
  workeraRows: readonly WorkeraRosterAuditRow[],
  localRows: readonly LocalRosterAuditRow[],
): WorkeraRosterStatusAudit {
  const statuses = emptyStatusCounts();
  const workeraByCode = new Map<string, SafeWorkeraStatus[]>();
  let workeraRecordsWithoutCode = 0;

  for (const row of workeraRows) {
    const status = normalizeStatus(row.employeeStatus);
    statuses[status] += 1;
    const code = cleanCode(row.code);
    if (!code) {
      workeraRecordsWithoutCode += 1;
      continue;
    }
    const existing = workeraByCode.get(code) ?? [];
    existing.push(status);
    workeraByCode.set(code, existing);
  }

  const contradictoryStatusCodes = [...workeraByCode.values()].filter((remoteStatuses) => {
    const known = new Set(remoteStatuses.filter((status) => status === "ACTIVO" || status === "INACTIVO"));
    return known.size > 1;
  }).length;

  const localByCode = new Map<string, LocalRosterAuditRow[]>();
  const localWorkeraByCode = new Map<string, LocalRosterAuditRow[]>();
  let localRecordsWithoutExternalCode = 0;
  let localWorkera = 0;
  let localProvisional = 0;
  let localOther = 0;

  for (const row of localRows) {
    const source = row.source.trim().toLocaleLowerCase("en-US");
    if (source === "workera") localWorkera += 1;
    else if (source === "local_provisional") localProvisional += 1;
    else localOther += 1;

    const code = cleanCode(row.externalWorkeraId);
    if (!code) {
      localRecordsWithoutExternalCode += 1;
      continue;
    }

    const allWithCode = localByCode.get(code) ?? [];
    allWithCode.push(row);
    localByCode.set(code, allWithCode);

    if (source === "workera") {
      const workeraSourced = localWorkeraByCode.get(code) ?? [];
      workeraSourced.push(row);
      localWorkeraByCode.set(code, workeraSourced);
    }
  }

  let matched = 0;
  let missingLocally = 0;
  let localActiveWorkeraInactive = 0;
  let localInactiveWorkeraActive = 0;
  let unresolvedMatchedStatus = 0;

  for (const [code, remoteStatuses] of workeraByCode) {
    const localMatches = localWorkeraByCode.get(code);
    if (!localMatches) {
      missingLocally += 1;
      continue;
    }
    matched += 1;

    const remoteStatus = resolveSingleValue(remoteStatuses);
    const localActive = resolveSingleValue(localMatches.map((row) => row.active));
    if (remoteStatus === "INACTIVO" && localActive === true) localActiveWorkeraInactive += 1;
    else if (remoteStatus === "ACTIVO" && localActive === false) localInactiveWorkeraActive += 1;
    else if (
      localActive === null ||
      remoteStatus === null ||
      remoteStatus === "SIN_ESTADO" ||
      remoteStatus === "OTRO"
    ) {
      unresolvedMatchedStatus += 1;
    }
  }

  let extraLocalWorkera = 0;
  for (const code of localWorkeraByCode.keys()) {
    if (!workeraByCode.has(code)) extraLocalWorkera += 1;
  }

  // Mantiene las claves de estado estables incluso si una corrida no contiene
  // alguna categoría; evita que consumidores infieran valores desde strings
  // arbitrarios entregados por el proveedor.
  const orderedStatuses = Object.fromEntries(
    SAFE_STATUS_ORDER.map((status) => [status, statuses[status]]),
  ) as Record<SafeWorkeraStatus, number>;

  return {
    schemaVersion: 1,
    readOnly: true,
    workera: {
      records: workeraRows.length,
      uniqueCodes: workeraByCode.size,
      duplicateCodeRows: Math.max(0, workeraRows.length - workeraRecordsWithoutCode - workeraByCode.size),
      contradictoryStatusCodes,
      recordsWithoutCode: workeraRecordsWithoutCode,
      statuses: orderedStatuses,
    },
    local: {
      employees: localRows.length,
      active: localRows.filter((row) => row.active).length,
      inactive: localRows.filter((row) => !row.active).length,
      uniqueExternalCodes: localByCode.size,
      duplicateExternalCodeRows: Math.max(0, localRows.length - localRecordsWithoutExternalCode - localByCode.size),
      recordsWithoutExternalCode: localRecordsWithoutExternalCode,
      sources: {
        workera: localWorkera,
        provisional: localProvisional,
        other: localOther,
      },
      workeraSource: {
        active: localRows.filter((row) => row.source.trim().toLocaleLowerCase("en-US") === "workera" && row.active).length,
        inactive: localRows.filter((row) => row.source.trim().toLocaleLowerCase("en-US") === "workera" && !row.active).length,
      },
    },
    comparison: {
      matched,
      missingLocally,
      extraLocalWorkera,
      provisionals: localProvisional,
      otherLocalSources: localOther,
      mismatches: {
        localActiveWorkeraInactive,
        localInactiveWorkeraActive,
        unresolvedMatchedStatus,
      },
    },
  };
}
