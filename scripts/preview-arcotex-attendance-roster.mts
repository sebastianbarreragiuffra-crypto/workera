import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  computeArcotexAttendanceRosterPreview,
  parseArcotexAttendanceRoster,
  type ArcotexExistingEmployee,
  type ArcotexExplicitResolution,
} from "../src/lib/employees/arcotex-attendance-roster";
import { CLAUDIO_BARRERA_PROVISIONAL_CODE } from "../src/lib/employees/local-provisional-employee";

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
const companyId = process.argv[4];
if (!sourcePath || !outputPath || !companyId) {
  throw new Error("Uso: preview-arcotex-attendance-roster <origen.xls> <salida.json> <company-id>");
}
if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Falta la configuración de staging para una lectura de empleados.");
}

const bytes = fs.readFileSync(sourcePath);
const expectedSourceSha256 = "E016A71DA0AC9A484847DCFF0FA8DAA99A806CEE0689FC9372051B7233D74B6C";
const sourceSha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
if (sourceSha256 !== expectedSourceSha256) {
  throw new Error(`El XLS no corresponde a la copia autorizada (SHA-256 recibido: ${sourceSha256}).`);
}
const parsed = parseArcotexAttendanceRoster(bytes);
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { data, error } = await supabase
  .from("employees")
  .select("id, external_workera_id, display_name, first_name, last_name, active")
  .eq("company_id", companyId)
  .order("id");
if (error) throw new Error(`No se pudo leer el padrón actual: ${error.message}`);

const employees: ArcotexExistingEmployee[] = (data ?? []).map((employee) => ({
  id: employee.id,
  externalWorkeraId: employee.external_workera_id,
  displayName: employee.display_name,
  firstName: employee.first_name,
  lastName: employee.last_name,
  active: employee.active,
}));
const employeeByCode = new Map(employees.map((employee) => [employee.externalWorkeraId, employee]));
const explicitSpecs = [
  {
    sourceNormalizedName: "MENDY MICHEL",
    externalWorkeraId: "12696643",
    evidence: "Confirmación explícita: corresponde a MICHEL ANDRE MENDY MUÑOZ; no a Mendy Lagos.",
  },
  {
    sourceNormalizedName: "MENDY LAGOS MICHEL",
    externalWorkeraId: "22587701",
    evidence: "El apellido LAGOS está expresamente incluido en la fila complementaria del mismo XLS.",
  },
  {
    sourceNormalizedName: "ÑANCUPIL S. JORGE",
    externalWorkeraId: "17325234",
    evidence: "La inicial S. de la fila complementaria distingue explícitamente la ficha ÑANCUPIL SALAS.",
  },
  {
    sourceNormalizedName: "ÑANCUPIL JORGE",
    externalWorkeraId: "7938527",
    evidence: "Resolución por contraste documentado: la fila ÑANCUPIL S. JORGE identifica a Salas y deja esta fila para ÑANCUPIL CALDERON.",
  },
  {
    sourceNormalizedName: "GONZALEZ PABLO",
    externalWorkeraId: "15313100",
    evidence: "Confirmación explícita: corresponde a PABLO ANDRES GONZALEZ PINTO.",
  },
] as const;
const resolutionWarnings: string[] = [];
const resolutions: ArcotexExplicitResolution[] = [];
for (const spec of explicitSpecs) {
  const employee = employeeByCode.get(spec.externalWorkeraId);
  if (!employee) {
    resolutionWarnings.push(`No existe el código Workera confirmado ${spec.externalWorkeraId} para ${spec.sourceNormalizedName}.`);
    continue;
  }
  resolutions.push({ sourceNormalizedName: spec.sourceNormalizedName, employeeId: employee.id, evidence: spec.evidence });
}

const preview = computeArcotexAttendanceRosterPreview(parsed, employees, resolutions, [
  {
    sourceNormalizedName: "BARRERA CLAUDIO",
    temporaryCode: CLAUDIO_BARRERA_PROVISIONAL_CODE,
    groupCode: "ADMINISTRATION",
    evidence: "Alta local provisional activa y exención NO_MARKING_REQUIRED autorizadas; RUT pendiente.",
  },
]);

const report = {
  generatedAt: new Date().toISOString(),
  sourcePath,
  sourceSha256,
  sourcePolicy: "El XLS sólo acredita nombres de personas reales de Arcotex; no determina vigencia, alta, baja, horario ni condición histórica.",
  stagingReadOnly: true,
  stagingEmployeesRead: employees.length,
  parse: parsed,
  resolutionWarnings,
  preview,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  rosterNames: parsed.rosterCount,
  duplicateRowsWithinSheet: parsed.duplicateRowsWithinSheet.length,
  parseBlockingIssues: parsed.issues.filter((issue) => issue.blocking).length,
  linked: preview.linkedCount,
  possibleNew: preview.possibleNewCount,
  ambiguous: preview.ambiguousCount,
  missingIdentity: preview.missingIdentityCount,
  okToApply: preview.okToApply,
  resolutionWarnings,
  stagingWritePerformed: false,
}, null, 2));
