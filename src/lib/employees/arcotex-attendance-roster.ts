import * as XLSX from "xlsx";
import { normalizeName } from "../business-rules/name-matching";

export const ARCOTEX_ATTENDANCE_SHEETS = ["NOV25", "DIC25", "ENERO", "FEBRERO", "MARZO"] as const;

type AttendanceSheetName = (typeof ARCOTEX_ATTENDANCE_SHEETS)[number];

export interface ArcotexRosterOccurrence {
  sheetName: AttendanceSheetName;
  rowNumber: number;
  rawName: string;
}

export interface ArcotexRosterPerson {
  sourceName: string;
  normalizedName: string;
  occurrences: ArcotexRosterOccurrence[];
}

export type ArcotexRosterParseIssueCode =
  | "INVALID_WORKBOOK"
  | "MISSING_SHEET"
  | "EMPTY_NAME"
  | "UNEXPECTED_ROSTER_COUNT";

export interface ArcotexRosterParseIssue {
  code: ArcotexRosterParseIssueCode;
  blocking: boolean;
  detail: string;
}

export interface ParsedArcotexAttendanceRoster {
  people: ArcotexRosterPerson[];
  rosterCount: number;
  duplicateRowsWithinSheet: Array<{
    normalizedName: string;
    sheetName: AttendanceSheetName;
    rowNumbers: number[];
  }>;
  issues: ArcotexRosterParseIssue[];
}

export interface ArcotexExistingEmployee {
  id: string;
  externalWorkeraId: string | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  active: boolean;
}

export interface ArcotexExplicitResolution {
  sourceNormalizedName: string;
  employeeId: string;
  evidence: string;
}

export interface ArcotexAuthorizedProvisionalCreate {
  sourceNormalizedName: string;
  temporaryCode: string;
  groupCode: "ADMINISTRATION" | "PRODUCTION" | "INSTALLATION";
  evidence: string;
}

export type ArcotexRosterMatchStatus =
  | "LINKED_EXACT_NAME"
  | "LINKED_EXPLICIT"
  | "POSSIBLE_NEW"
  | "AMBIGUOUS"
  | "MISSING_IDENTITY";

export interface ArcotexRosterCandidate {
  employeeId: string;
  externalWorkeraId: string | null;
  displayName: string;
  active: boolean;
}

export interface ArcotexRosterPreviewRow {
  sourceName: string;
  normalizedName: string;
  sourceSheets: AttendanceSheetName[];
  sourceRows: string[];
  status: ArcotexRosterMatchStatus;
  matchedEmployee: ArcotexRosterCandidate | null;
  candidates: ArcotexRosterCandidate[];
  matchMethod: "FULL_NAME_EXACT" | "EXPLICIT_RESOLUTION" | "NONE";
  evidence: string;
}

export interface ArcotexRosterPreview {
  rows: ArcotexRosterPreviewRow[];
  linkedCount: number;
  possibleNewCount: number;
  ambiguousCount: number;
  missingIdentityCount: number;
  blockingReasons: string[];
  okToApply: boolean;
}

const SCHEDULE_OR_NOTE = /\s+(?=(?:LUNES|MARTES|MIERCOLES|MIÉRCOLES|JUEVES|VIERNES|SABADO|SÁBADO|DOMINGO|HORARIO|JORNADA|TURNO|INGRESO|COLACION|COLACIÓN|FINIQUITO)\b)/i;

function cleanAttendanceName(value: unknown): string {
  return String(value ?? "")
    .split(/\r?\n/, 1)[0]
    .split(SCHEDULE_OR_NOTE, 1)[0]
    .trim();
}

function toRows(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
    blankrows: false,
  });
}

/**
 * Lee el formato histórico de Asistencia de Arcotex sin modificarlo.
 * Sólo las filas nominales de las cinco hojas autorizadas forman el padrón.
 * Ninguna fecha, RUT, horario o anotación del libro se usa como dato maestro.
 */
export function parseArcotexAttendanceRoster(fileBytes: Uint8Array): ParsedArcotexAttendanceRoster {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(fileBytes, { type: "array", cellDates: true });
  } catch {
    return {
      people: [],
      rosterCount: 0,
      duplicateRowsWithinSheet: [],
      issues: [{ code: "INVALID_WORKBOOK", blocking: true, detail: "El archivo no es un libro Excel legible." }],
    };
  }

  const issues: ArcotexRosterParseIssue[] = [];
  const occurrencesByName = new Map<string, ArcotexRosterOccurrence[]>();
  const preferredNameByNormalized = new Map<string, string>();

  for (const sheetName of ARCOTEX_ATTENDANCE_SHEETS) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      issues.push({ code: "MISSING_SHEET", blocking: true, detail: `Falta la hoja obligatoria ${sheetName}.` });
      continue;
    }

    const rows = toRows(sheet);
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index] ?? [];
      if (normalizeName(String(row[1] ?? "")) !== "ASISTENCIA") continue;
      const sourceName = cleanAttendanceName(row[0]);
      const normalizedName = normalizeName(sourceName);
      if (!normalizedName) {
        issues.push({ code: "EMPTY_NAME", blocking: true, detail: `${sheetName}, fila ${index + 1}: bloque Asistencia sin nombre.` });
        continue;
      }

      preferredNameByNormalized.set(normalizedName, preferredNameByNormalized.get(normalizedName) ?? sourceName);
      const occurrence: ArcotexRosterOccurrence = {
        sheetName,
        rowNumber: index + 1,
        rawName: String(row[0] ?? ""),
      };
      const previous = occurrencesByName.get(normalizedName) ?? [];
      previous.push(occurrence);
      occurrencesByName.set(normalizedName, previous);
    }
  }

  const people = [...occurrencesByName.entries()].map(([normalizedName, occurrences]) => ({
    sourceName: preferredNameByNormalized.get(normalizedName) ?? normalizedName,
    normalizedName,
    occurrences,
  }));

  const duplicateRowsWithinSheet: ParsedArcotexAttendanceRoster["duplicateRowsWithinSheet"] = [];
  for (const person of people) {
    for (const sheetName of ARCOTEX_ATTENDANCE_SHEETS) {
      const rows = person.occurrences.filter((occurrence) => occurrence.sheetName === sheetName).map((occurrence) => occurrence.rowNumber);
      if (rows.length > 1) duplicateRowsWithinSheet.push({ normalizedName: person.normalizedName, sheetName, rowNumbers: rows });
    }
  }

  if (people.length !== 60) {
    issues.push({ code: "UNEXPECTED_ROSTER_COUNT", blocking: true, detail: `Se esperaban 60 nombres autorizados de Arcotex y se obtuvieron ${people.length}.` });
  }

  return {
    people,
    rosterCount: people.length,
    duplicateRowsWithinSheet,
    issues,
  };
}

function employeeCandidate(employee: ArcotexExistingEmployee): ArcotexRosterCandidate {
  return {
    employeeId: employee.id,
    externalWorkeraId: employee.externalWorkeraId,
    displayName: employee.displayName,
    active: employee.active,
  };
}

function exactNameAliases(employee: ArcotexExistingEmployee): Set<string> {
  return new Set(
    [
      employee.displayName,
      `${employee.firstName ?? ""} ${employee.lastName ?? ""}`,
      `${employee.lastName ?? ""} ${employee.firstName ?? ""}`,
    ]
      .map(normalizeName)
      .filter(Boolean),
  );
}

function suggestionCandidates(sourceName: string, employees: ArcotexExistingEmployee[]): ArcotexRosterCandidate[] {
  const tokens = normalizeName(sourceName).split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  return employees
    .filter((employee) => {
      const employeeTokens = normalizeName(employee.displayName).split(" ").filter(Boolean);
      return tokens.every((token) =>
        token.length === 1 ? employeeTokens.some((candidate) => candidate.startsWith(token)) : employeeTokens.includes(token),
      );
    })
    .map(employeeCandidate);
}

/**
 * Construye una vista previa; no escribe datos. Los candidatos parciales se
 * muestran sólo como evidencia y siguen bloqueando. Una resolución manual
 * debe identificar al empleado y explicar su evidencia.
 */
export function computeArcotexAttendanceRosterPreview(
  parsed: ParsedArcotexAttendanceRoster,
  employees: ArcotexExistingEmployee[],
  explicitResolutions: ArcotexExplicitResolution[] = [],
  authorizedProvisionalCreates: ArcotexAuthorizedProvisionalCreate[] = [],
): ArcotexRosterPreview {
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const explicitBySourceName = new Map(explicitResolutions.map((resolution) => [normalizeName(resolution.sourceNormalizedName), resolution]));
  const provisionalBySourceName = new Map(authorizedProvisionalCreates.map((create) => [normalizeName(create.sourceNormalizedName), create]));

  const rows = parsed.people.map<ArcotexRosterPreviewRow>((person) => {
    const explicit = explicitBySourceName.get(person.normalizedName);
    if (explicit) {
      const employee = employeesById.get(explicit.employeeId);
      if (employee && explicit.evidence.trim()) {
        return {
          sourceName: person.sourceName,
          normalizedName: person.normalizedName,
          sourceSheets: [...new Set(person.occurrences.map((occurrence) => occurrence.sheetName))],
          sourceRows: person.occurrences.map((occurrence) => `${occurrence.sheetName}!${occurrence.rowNumber}`),
          status: "LINKED_EXPLICIT",
          matchedEmployee: employeeCandidate(employee),
          candidates: [],
          matchMethod: "EXPLICIT_RESOLUTION",
          evidence: explicit.evidence.trim(),
        };
      }
    }

    const exactMatches = employees.filter((employee) => exactNameAliases(employee).has(person.normalizedName));
    if (exactMatches.length === 1) {
      return {
        sourceName: person.sourceName,
        normalizedName: person.normalizedName,
        sourceSheets: [...new Set(person.occurrences.map((occurrence) => occurrence.sheetName))],
        sourceRows: person.occurrences.map((occurrence) => `${occurrence.sheetName}!${occurrence.rowNumber}`),
        status: "LINKED_EXACT_NAME",
        matchedEmployee: employeeCandidate(exactMatches[0]),
        candidates: [],
        matchMethod: "FULL_NAME_EXACT",
        evidence: "Nombre completo normalizado exactamente igual a un único empleado existente.",
      };
    }

    const provisional = provisionalBySourceName.get(person.normalizedName);
    if (provisional && provisional.temporaryCode.startsWith("LOCAL-PROVISIONAL:") && provisional.evidence.trim()) {
      return {
        sourceName: person.sourceName,
        normalizedName: person.normalizedName,
        sourceSheets: [...new Set(person.occurrences.map((occurrence) => occurrence.sheetName))],
        sourceRows: person.occurrences.map((occurrence) => `${occurrence.sheetName}!${occurrence.rowNumber}`),
        status: "POSSIBLE_NEW",
        matchedEmployee: null,
        candidates: [],
        matchMethod: "NONE",
        evidence: `${provisional.evidence.trim()} Grupo ${provisional.groupCode}; clave técnica ${provisional.temporaryCode}.`,
      };
    }

    const candidates = suggestionCandidates(person.sourceName, employees);
    return {
      sourceName: person.sourceName,
      normalizedName: person.normalizedName,
      sourceSheets: [...new Set(person.occurrences.map((occurrence) => occurrence.sheetName))],
      sourceRows: person.occurrences.map((occurrence) => `${occurrence.sheetName}!${occurrence.rowNumber}`),
      status: candidates.length > 0 || exactMatches.length > 1 ? "AMBIGUOUS" : "MISSING_IDENTITY",
      matchedEmployee: null,
      candidates,
      matchMethod: "NONE",
      evidence: exactMatches.length > 1
        ? "El nombre completo coincide con más de un empleado. Requiere RUT/código o resolución explícita."
        : candidates.length > 0
          ? "Coincidencia parcial mostrada sólo como sugerencia; no autoriza vinculación automática."
          : "No existe RUT/código estable ni coincidencia exacta aprobada.",
    };
  });

  const linkedStatuses = new Set<ArcotexRosterMatchStatus>(["LINKED_EXACT_NAME", "LINKED_EXPLICIT"]);
  const blockingReasons = parsed.issues.filter((issue) => issue.blocking).map((issue) => issue.detail);
  const unresolved = rows.filter((row) => row.status === "AMBIGUOUS" || row.status === "MISSING_IDENTITY");
  if (unresolved.length > 0) blockingReasons.push(`${unresolved.length} personas no tienen una identidad vinculada con evidencia suficiente.`);

  return {
    rows,
    linkedCount: rows.filter((row) => linkedStatuses.has(row.status)).length,
    possibleNewCount: rows.filter((row) => row.status === "POSSIBLE_NEW").length,
    ambiguousCount: rows.filter((row) => row.status === "AMBIGUOUS").length,
    missingIdentityCount: rows.filter((row) => row.status === "MISSING_IDENTITY").length,
    blockingReasons,
    okToApply: blockingReasons.length === 0,
  };
}

/** Falla cerrado: jamás entrega un padrón de exportación desde una vista previa incompleta. */
export function approvedArcotexEmployeeIds(preview: ArcotexRosterPreview): Set<string> {
  if (!preview.okToApply) {
    throw new Error(`El padrón Arcotex no está aprobado: ${preview.blockingReasons.join(" ")}`);
  }
  const unpersistedRows = preview.rows.filter((row) => !row.matchedEmployee);
  if (unpersistedRows.length > 0) {
    throw new Error(
      `El padrón Arcotex tiene ${unpersistedRows.length} altas autorizadas aún no persistidas; deben crearse y volver a conciliarse antes de exportar.`,
    );
  }
  return new Set(
    preview.rows.map((row) => row.matchedEmployee!.employeeId),
  );
}
