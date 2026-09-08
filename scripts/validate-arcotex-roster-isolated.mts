import "server-only";

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  ARCOTEX_ATTENDANCE_ROSTER_SIZE,
  approvedArcotexEmployeeIds,
  computeArcotexAttendanceRosterPreview,
  parseArcotexAttendanceRoster,
  type ArcotexExplicitResolution,
} from "../src/lib/employees/arcotex-attendance-roster";

const sourcePath = process.argv[2];
const approvedPreviewPath = process.argv[3];
const outputPath = process.argv[4];
const companyId = process.argv[5];
if (!sourcePath || !approvedPreviewPath || !outputPath || !companyId) {
  throw new Error("Uso: validate-arcotex-roster-isolated <origen.xls> <preview-aprobada.json> <salida.json> <company-id>");
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Falta la configuración de la Supabase aislada.");
}
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.NEXT_PUBLIC_SUPABASE_URL)) {
  throw new Error("Esta validación sólo puede escribir en una Supabase local aislada sobre 127.0.0.1.");
}

const sourceBytes = fs.readFileSync(sourcePath);
const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex").toUpperCase();
const approvedReport = JSON.parse(fs.readFileSync(approvedPreviewPath, "utf8")) as {
  sourceSha256: string;
  stagingReadOnly: boolean;
  preview: {
    rows: Array<{
      normalizedName: string;
      status: string;
      evidence: string;
      matchedEmployee: null | {
        employeeId: string;
        externalWorkeraId: string;
        displayName: string;
        active: boolean;
      };
    }>;
  };
};
if (approvedReport.sourceSha256 !== sourceSha256 || approvedReport.stagingReadOnly !== true) {
  throw new Error("La vista aprobada no corresponde al XLS autorizado o no acredita lectura de staging sin escritura.");
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data: administrationGroup, error: groupError } = await supabase
  .from("employee_groups")
  .select("id")
  .eq("company_id", companyId)
  .eq("code", "ADMINISTRATION")
  .single();
if (groupError || !administrationGroup) throw new Error(`No se encontró ADMINISTRATION en la base aislada: ${groupError?.message ?? "sin fila"}`);

const matchedRows = approvedReport.preview.rows.filter((row) => row.matchedEmployee !== null);
if (matchedRows.length !== ARCOTEX_ATTENDANCE_ROSTER_SIZE) {
  throw new Error(
    `Se esperaban ${ARCOTEX_ATTENDANCE_ROSTER_SIZE} fichas aprobadas para sembrar; se recibieron ${matchedRows.length}.`,
  );
}
const isolatedSeedRows = matchedRows.map((row) => {
  const matched = row.matchedEmployee!;
  const tokens = matched.displayName.trim().split(/\s+/);
  return {
    id: matched.employeeId,
    company_id: companyId,
    external_workera_id: matched.externalWorkeraId,
    rut: null,
    first_name: tokens[0] ?? matched.displayName,
    last_name: tokens.slice(1).join(" ") || "SIN APELLIDO",
    display_name: matched.displayName,
    employee_group_id: administrationGroup.id,
    active: matched.active,
    source: "workera" as const,
  };
});
const { error: seedError } = await supabase.from("employees").upsert(isolatedSeedRows, { onConflict: "id" });
if (seedError) {
  throw new Error(`No se pudieron cargar las ${ARCOTEX_ATTENDANCE_ROSTER_SIZE} fichas aisladas: ${seedError.message}`);
}

const { data: isolatedEmployees, error: employeesError } = await supabase
  .from("employees")
  .select("id, external_workera_id, display_name, first_name, last_name, active")
  .eq("company_id", companyId)
  .order("id");
if (employeesError) throw new Error(`No se pudo releer el padrón aislado: ${employeesError.message}`);

const resolutions: ArcotexExplicitResolution[] = approvedReport.preview.rows
  .filter((row) => row.matchedEmployee)
  .map((row) => ({
    sourceNormalizedName: row.normalizedName,
    employeeId: row.matchedEmployee!.employeeId,
    evidence: row.evidence,
  }));
const parsed = parseArcotexAttendanceRoster(sourceBytes);
const preview = computeArcotexAttendanceRosterPreview(
  parsed,
  (isolatedEmployees ?? []).map((employee) => ({
    id: employee.id,
    externalWorkeraId: employee.external_workera_id,
    displayName: employee.display_name,
    firstName: employee.first_name,
    lastName: employee.last_name,
    active: employee.active,
  })),
  resolutions,
);
const unresolvedRows = preview.rows
  .filter((row) => row.status === "AMBIGUOUS" || row.status === "MISSING_IDENTITY")
  .map((row) => `${row.sourceName} (${row.status}; candidatos=${row.candidates.length})`);
if (unresolvedRows.length > 0) {
  throw new Error(`La conciliación aislada dejó pendientes: ${unresolvedRows.join(", ")}.`);
}
const approvedIds = approvedArcotexEmployeeIds(preview);
if (
  preview.rows.length !== ARCOTEX_ATTENDANCE_ROSTER_SIZE
  || preview.linkedCount !== ARCOTEX_ATTENDANCE_ROSTER_SIZE
  || preview.possibleNewCount !== 0
  || approvedIds.size !== ARCOTEX_ATTENDANCE_ROSTER_SIZE
) {
  throw new Error(
    `Conciliación aislada incompleta: filas=${preview.rows.length}, vinculadas=${preview.linkedCount}, provisionales pendientes=${preview.possibleNewCount}, ids=${approvedIds.size}.`,
  );
}

const report = {
  executedAt: new Date().toISOString(),
  commit: process.env.GIT_COMMIT ?? null,
  environment: "Supabase local aislada",
  sharedSupabaseUsed: false,
  productionDataUsed: false,
  sourceSha256,
  seededExistingEmployees: isolatedSeedRows.length,
  preview,
  approvedEmployeeIds: approvedIds.size,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  outputPath,
  seededExistingEmployees: isolatedSeedRows.length,
  linked: preview.linkedCount,
  ambiguous: preview.ambiguousCount,
  missingIdentity: preview.missingIdentityCount,
  approvedEmployeeIds: approvedIds.size,
  sharedSupabaseWritePerformed: false,
}, null, 2));
