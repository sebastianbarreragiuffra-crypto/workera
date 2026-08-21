import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { getAttendanceReadiness } from "./attendance-readiness";
import { resolveTargetDate } from "../sync/target-date";

/**
 * `getAttendanceReadiness` no recalcula nada -- combina `getDailyReview`
 * (Fase 7) y `listMedicalLicenses` (aprobación de licencias médicas), ambos
 * ya probados por su cuenta. Este mock simula las mismas tablas que esos dos
 * servicios consultan (ver daily-review.ts y medical-license.ts) para
 * verificar el ENSAMBLE -- mensajes, conteo, scoping por rol y el corte D-1
 * -- no la lógica interna de ninguno de los dos.
 */

const GROUPS = [
  { id: "grp-production", code: "PRODUCTION" },
  { id: "grp-installation", code: "INSTALLATION" },
  { id: "grp-administration", code: "ADMINISTRATION" },
];

interface Fixture {
  employees?: unknown[];
  late_arrival_records?: unknown[];
  early_departure_records?: unknown[];
  attendance_missing_punch_flags?: unknown[];
  absence_records?: unknown[];
  overtime_records?: unknown[];
  medical_license_approvals?: unknown[];
}

function selectBuilder(rows: unknown[]) {
  let filtered = rows;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builder: any = {
    select() {
      return builder;
    },
    eq(col: string, value: unknown) {
      filtered = filtered.filter((r) => (r as Record<string, unknown>)[col] === value);
      return builder;
    },
    in(col: string, values: unknown[]) {
      filtered = filtered.filter((r) => values.includes((r as Record<string, unknown>)[col]));
      return builder;
    },
    lte(col: string, value: unknown) {
      filtered = filtered.filter((r) => (r as Record<string, unknown>)[col] as string <= (value as string));
      return builder;
    },
    gte(col: string, value: unknown) {
      filtered = filtered.filter((r) => (r as Record<string, unknown>)[col] as string >= (value as string));
      return builder;
    },
    order() {
      return builder;
    },
    single() {
      return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: "no rows" } });
    },
    maybeSingle() {
      return Promise.resolve({ data: filtered[0] ?? null, error: null });
    },
    then(onResolve: (r: { data: unknown; error: null }) => void) {
      onResolve({ data: filtered, error: null });
    },
  };
  return builder;
}

function mockSupabase(fixture: Fixture) {
  return {
    from(table: string) {
      if (table === "employee_groups") return selectBuilder(GROUPS);
      if (table === "employees") return selectBuilder(fixture.employees ?? []);
      if (table === "late_arrival_records") return selectBuilder(fixture.late_arrival_records ?? []);
      if (table === "early_departure_records") return selectBuilder(fixture.early_departure_records ?? []);
      if (table === "attendance_missing_punch_flags") return selectBuilder(fixture.attendance_missing_punch_flags ?? []);
      if (table === "absence_records") return selectBuilder(fixture.absence_records ?? []);
      if (table === "overtime_records") return selectBuilder(fixture.overtime_records ?? []);
      if (table === "medical_license_approvals") return selectBuilder(fixture.medical_license_approvals ?? []);
      throw new Error(`mockSupabase: tabla no soportada en este fixture: ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const CUTOFF = "2026-08-19";
const NOW = new Date("2026-08-20T15:00:00Z"); // America/Santiago D-1 -> 2026-08-19

// A) Sin novedades -> verde, sin bloqueadores.
test("getAttendanceReadiness: sin novedades en ninguna categoría ni licencias pendientes -> ready=true, sin bloqueadores", async () => {
  const fixture: Fixture = {
    employees: [{ id: "emp-1", display_name: "Ana Torres", employee_group_id: "grp-production", active: true }],
  };
  const result = await getAttendanceReadiness(mockSupabase(fixture) as never, "SUPERVISOR_PRODUCTION", NOW);

  assert.equal(result.cutoffDate, CUTOFF);
  assert.equal(result.ready, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.totalBlockerCount, 0);
});

// B) Licencia médica pendiente -> amarillo, con el mensaje exacto requerido; una ya aprobada no bloquea.
test("getAttendanceReadiness: licencia médica PENDING_RRHH_APPROVAL -> bloqueador con el mensaje exacto; una APPROVED no bloquea", async () => {
  const pendingLicenseRow = {
    id: "lic-pending",
    status: "PENDING_RRHH_APPROVAL",
    proposed_start_date: "2026-08-18",
    proposed_end_date: "2026-08-20",
    extraction_status: null,
    confirmed_start_date: null,
    confirmed_end_date: null,
    uploaded_at: "2026-08-18T10:00:00Z",
    approved_at: null,
    rejected_at: null,
    rejection_reason: null,
    supporting_document_id: "doc-1",
    absence_records: { employee_id: "emp-2", employees: { display_name: "Bruno Silva", employee_groups: { code: "PRODUCTION" } } },
    uploader: { display_name: "Bruno Silva" },
    approver: null,
    rejecter: null,
  };
  const approvedLicenseRow = { ...pendingLicenseRow, id: "lic-approved", status: "APPROVED" };

  const fixture: Fixture = {
    employees: [{ id: "emp-2", display_name: "Bruno Silva", employee_group_id: "grp-production", active: true }],
    medical_license_approvals: [pendingLicenseRow, approvedLicenseRow],
  };
  const result = await getAttendanceReadiness(mockSupabase(fixture) as never, "SUPERVISOR_PRODUCTION", NOW);

  assert.equal(result.ready, false);
  assert.equal(result.totalBlockerCount, 1);
  assert.equal(result.blockers[0].message, "Falta aprobar licencia de Bruno Silva por RRHH.");
  assert.equal(result.blockers[0].href, "/licencias");
});

// C) Ausencia de tipo VACATION sin decisión -> mensaje específico de vacaciones, no el genérico de ausencia.
test("getAttendanceReadiness: ausencia VACATION sin decisión -> mensaje 'Falta aprobar vacaciones de ... por RRHH.'", async () => {
  const fixture: Fixture = {
    employees: [{ id: "emp-3", display_name: "Carla Muñoz", employee_group_id: "grp-production", active: true }],
    absence_records: [
      {
        employee_id: "emp-3",
        start_date: "2026-08-15",
        end_date: "2026-08-22",
        is_current: true,
        absence_decisions: [],
        absence_types: { code: "VACATION" },
      },
    ],
  };
  const result = await getAttendanceReadiness(mockSupabase(fixture) as never, "SUPERVISOR_PRODUCTION", NOW);

  assert.equal(result.ready, false);
  assert.equal(result.totalBlockerCount, 1);
  assert.equal(result.blockers[0].message, "Falta aprobar vacaciones de Carla Muñoz por RRHH.");
  assert.equal(result.blockers[0].href, `/revision-diaria?fecha=${CUTOFF}&area=PRODUCTION&empleado=emp-3`);
});

// C.2) Ausencia sin decisión que NO es vacaciones -> mensaje genérico, nunca el de vacaciones.
test("getAttendanceReadiness: ausencia sin decisión de un tipo distinto a VACATION -> mensaje genérico de ausencia", async () => {
  const fixture: Fixture = {
    employees: [{ id: "emp-4", display_name: "Diego Rojas", employee_group_id: "grp-production", active: true }],
    absence_records: [
      {
        employee_id: "emp-4",
        start_date: "2026-08-19",
        end_date: "2026-08-19",
        is_current: true,
        absence_decisions: [],
        absence_types: { code: "PERMIT" },
      },
    ],
  };
  const result = await getAttendanceReadiness(mockSupabase(fixture) as never, "SUPERVISOR_PRODUCTION", NOW);

  assert.equal(result.blockers[0].message, "Ausencia de Diego Rojas sin decisión.");
});

// D) Varios bloqueadores combinados -> conteo correcto.
test("getAttendanceReadiness: atraso + horas extra + licencia médica pendiente -> totalBlockerCount=3", async () => {
  const fixture: Fixture = {
    employees: [
      { id: "emp-5", display_name: "Elena Paz", employee_group_id: "grp-production", active: true },
      { id: "emp-6", display_name: "Franco Lima", employee_group_id: "grp-production", active: true },
    ],
    late_arrival_records: [{ employee_id: "emp-5", work_date: CUTOFF, is_current: true, late_arrival_decisions: [] }],
    overtime_records: [{ employee_id: "emp-6", work_date: CUTOFF, is_current: true, overtime_decisions: [] }],
    medical_license_approvals: [
      {
        id: "lic-3",
        status: "PENDING_RRHH_APPROVAL",
        proposed_start_date: "2026-08-10",
        proposed_end_date: "2026-08-25",
        extraction_status: null,
        confirmed_start_date: null,
        confirmed_end_date: null,
        uploaded_at: "2026-08-10T10:00:00Z",
        approved_at: null,
        rejected_at: null,
        rejection_reason: null,
        supporting_document_id: "doc-3",
        absence_records: { employee_id: "emp-7", employees: { display_name: "Gina Torres", employee_groups: { code: "PRODUCTION" } } },
        uploader: { display_name: "Gina Torres" },
        approver: null,
        rejecter: null,
      },
    ],
  };
  const result = await getAttendanceReadiness(mockSupabase(fixture) as never, "SUPERVISOR_PRODUCTION", NOW);

  assert.equal(result.ready, false);
  assert.equal(result.totalBlockerCount, 3);
});

// E) Un supervisor nunca ve los bloqueadores de otra área (mismo criterio que getDailyReview/dashboard-view).
test("getAttendanceReadiness: SUPERVISOR_PRODUCTION nunca ve bloqueadores de INSTALLATION", async () => {
  const fixture: Fixture = {
    employees: [
      { id: "emp-prod", display_name: "Prod Uno", employee_group_id: "grp-production", active: true },
      { id: "emp-inst", display_name: "Inst Uno", employee_group_id: "grp-installation", active: true },
    ],
    late_arrival_records: [
      { employee_id: "emp-prod", work_date: CUTOFF, is_current: true, late_arrival_decisions: [] },
      { employee_id: "emp-inst", work_date: CUTOFF, is_current: true, late_arrival_decisions: [] },
    ],
  };
  const resultProd = await getAttendanceReadiness(mockSupabase(fixture) as never, "SUPERVISOR_PRODUCTION", NOW);
  assert.equal(resultProd.totalBlockerCount, 1);
  assert.ok(resultProd.blockers[0].href.includes("area=PRODUCTION"));

  const resultInst = await getAttendanceReadiness(mockSupabase(fixture) as never, "SUPERVISOR_INSTALLATION", NOW);
  assert.equal(resultInst.totalBlockerCount, 1);
  assert.ok(resultInst.blockers[0].href.includes("area=INSTALLATION"));
});

// F) Corte D-1 America/Santiago -- nunca "hoy".
test("getAttendanceReadiness: usa resolveTargetDate (D-1 America/Santiago), nunca la fecha de 'now' directamente", async () => {
  const fixture: Fixture = { employees: [] };
  const result = await getAttendanceReadiness(mockSupabase(fixture) as never, "SUPER_ADMIN", NOW);
  assert.equal(result.cutoffDate, resolveTargetDate(NOW));
  assert.equal(result.cutoffDate, "2026-08-19");
});

// G) Las dos tarjetas compactas van una junto a la otra en el Dashboard, en su propia fila (no mezcladas con Pendientes/Revisión/Eventos).
test("dashboard/page.tsx: DescargarAsistenciaCard y AttendanceReadinessCard están en la misma fila de 2 columnas", () => {
  const pagePath = path.join(import.meta.dirname, "..", "..", "app", "(app)", "dashboard", "page.tsx");
  const content = readFileSync(pagePath, "utf8");

  const rowMatch = content.match(/<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">([\s\S]*?)<\/div>/);
  assert.ok(rowMatch, "debe existir una fila grid-cols-2 en el Dashboard");
  assert.match(rowMatch![1], /<DescargarAsistenciaCard/);
  assert.match(rowMatch![1], /<AttendanceReadinessCard/);
});
