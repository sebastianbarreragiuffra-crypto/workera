import {
  ARCOTEX_ATTENDANCE_ROSTER_NAMES_SHA256,
  approvedArcotexEmployeeIds,
  canonicalArcotexRosterNamesSha256,
  computeArcotexAttendanceRosterPreview,
  parseArcotexAttendanceRoster,
  type ArcotexExistingEmployee,
  type ArcotexExplicitResolution,
  type ArcotexRosterPreview,
  type ParsedArcotexAttendanceRoster,
} from "./arcotex-attendance-roster";
import {
  ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
  canonicalRosterSha256,
} from "./arcotex-pilot-roster";

export function canonicalCandidateResolutions(
  preview: ArcotexRosterPreview,
  employees: ArcotexExistingEmployee[],
  expectedRosterSize = ARCOTEX_AUTHORIZED_ROSTER_SIZE,
  expectedRosterSha256 = ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256,
): ArcotexExplicitResolution[] {
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const fixedEmployeeIds = new Set(
    preview.rows
      .map((row) => row.matchedEmployee?.employeeId)
      .filter((employeeId): employeeId is string => Boolean(employeeId)),
  );
  const unresolved = preview.rows
    .filter((row) => !row.matchedEmployee)
    .map((row) => ({
      row,
      candidateIds: row.candidates.length > 0
        ? row.candidates.map((candidate) => candidate.employeeId)
        : employees
            .filter((employee) => employee.externalWorkeraId)
            .map((employee) => employee.id),
    }))
    .sort((left, right) => left.candidateIds.length - right.candidateIds.length);

  const solutionsByRoster = new Map<string, ArcotexExplicitResolution[]>();
  let evaluatedAssignments = 0;
  const visit = (
    index: number,
    selectedEmployeeIds: Set<string>,
    resolutions: ArcotexExplicitResolution[],
  ): void => {
    if (evaluatedAssignments > 10_000) {
      throw new Error("La conciliación produjo demasiadas combinaciones y requiere revisión explícita.");
    }
    if (index === unresolved.length) {
      evaluatedAssignments += 1;
      if (selectedEmployeeIds.size !== expectedRosterSize) return;
      const codes = [...selectedEmployeeIds].map((employeeId) => employeeById.get(employeeId)?.externalWorkeraId ?? "");
      if (
        codes.some((code) => !code)
        || new Set(codes).size !== expectedRosterSize
        || canonicalRosterSha256(codes) !== expectedRosterSha256
      ) return;
      const rosterKey = [...selectedEmployeeIds].sort().join(",");
      if (!solutionsByRoster.has(rosterKey)) solutionsByRoster.set(rosterKey, [...resolutions]);
      return;
    }

    const item = unresolved[index];
    for (const employeeId of item.candidateIds) {
      if (selectedEmployeeIds.has(employeeId)) continue;
      selectedEmployeeIds.add(employeeId);
      resolutions.push({
        sourceNormalizedName: item.row.normalizedName,
        employeeId,
        evidence: "Asignación autorizada por el usuario y validada contra la huella canónica del padrón ARCOTEX.",
      });
      visit(index + 1, selectedEmployeeIds, resolutions);
      resolutions.pop();
      selectedEmployeeIds.delete(employeeId);
    }
  };

  visit(0, new Set(fixedEmployeeIds), []);
  if (solutionsByRoster.size !== 1) {
    throw new Error(
      solutionsByRoster.size === 0
        ? "Ninguna conciliación coincide con la huella canónica del padrón ARCOTEX."
        : "Más de un padrón coincide con la conciliación; se requiere evidencia adicional.",
    );
  }
  return [...solutionsByRoster.values()][0];
}

export interface ArcotexAuthorizedRosterReconciliation {
  parsed: ParsedArcotexAttendanceRoster;
  preview: ArcotexRosterPreview;
  employeeIds: string[] | null;
  workeraCodes: string[] | null;
  approvedCandidateMatches: number;
}

/**
 * Convierte el libro autoritativo FEBRERO/MARZO en el padrón técnico exacto.
 * Sólo concilia fichas existentes de ARCOTEX; no crea ni modifica personas.
 */
export function reconcileArcotexAuthoritativeRoster(
  sourceBytes: Uint8Array,
  employees: ArcotexExistingEmployee[],
  options: { approveAuthoritativeRoster?: boolean } = {},
): ArcotexAuthorizedRosterReconciliation {
  const parsed = parseArcotexAttendanceRoster(sourceBytes);
  const sourceNamesSha256 = canonicalArcotexRosterNamesSha256(
    parsed.people.map((person) => person.normalizedName),
  );
  if (sourceNamesSha256 !== ARCOTEX_ATTENDANCE_ROSTER_NAMES_SHA256) {
    throw new Error("Los nombres de FEBRERO y MARZO no corresponden al padrón autorizado de ARCOTEX.");
  }

  const preliminary = computeArcotexAttendanceRosterPreview(parsed, employees);
  const candidateApprovals = options.approveAuthoritativeRoster
    ? canonicalCandidateResolutions(preliminary, employees)
    : [];
  const preview = computeArcotexAttendanceRosterPreview(parsed, employees, candidateApprovals);
  if (!preview.okToApply || preview.possibleNewCount > 0) {
    return {
      parsed,
      preview,
      employeeIds: null,
      workeraCodes: null,
      approvedCandidateMatches: candidateApprovals.length,
    };
  }
  const approvedIds = approvedArcotexEmployeeIds(preview);
  const employeeById = new Map(employees.map((employee) => [employee.id, employee]));
  const workeraCodes = [...approvedIds].map((employeeId) => {
    const code = employeeById.get(employeeId)?.externalWorkeraId?.trim();
    if (!code) throw new Error("Una ficha conciliada no tiene código Workera estable.");
    return code;
  });
  if (
    workeraCodes.length !== ARCOTEX_AUTHORIZED_ROSTER_SIZE
    || new Set(workeraCodes).size !== ARCOTEX_AUTHORIZED_ROSTER_SIZE
    || canonicalRosterSha256(workeraCodes) !== ARCOTEX_AUTHORIZED_WORKERA_CODES_SHA256
  ) {
    throw new Error("La conciliación por nombres no coincide con los 45 códigos Workera autorizados.");
  }

  return {
    parsed,
    preview,
    employeeIds: [...approvedIds].sort(),
    workeraCodes: workeraCodes.sort(),
    approvedCandidateMatches: candidateApprovals.length,
  };
}
