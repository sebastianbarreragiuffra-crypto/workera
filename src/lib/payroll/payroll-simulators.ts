import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx-js-style";
import {
  buildAttendanceExportWorkbook,
  calendarDaysBetween,
  isWeekend,
  payrollWorkbookConflicts,
  type AttendanceExportData,
  type AttendanceExportDay,
  type AttendanceExportWorker,
} from "../business-rules/attendance-export";
import {
  evaluatePayrollOvertime,
  type PayrollOvertimeResult,
} from "../business-rules/payroll-overtime-rules";
import { decideEarlyDepartureOther } from "../decisions/early-departure-decisions";
import { decideLateArrival } from "../decisions/late-arrival-decisions";
import { transitionReportingPeriod } from "../periods/reporting-periods";
import type { Database } from "../supabase/database.types";
import {
  closePayrollPeriodWithSnapshot,
  type PayrollPeriodCloseDependencies,
} from "./payroll-period-close";
import {
  applyPayrollWorkbookConflictResolutions,
  comparePayrollWorkbooks,
  parsePayrollWorkbook,
  validatePayrollWorkbookBusinessChanges,
  type PayrollWorkbookChange,
} from "./payroll-workbook-upload";
import { acceptTrustedPayrollWorkbook } from "../payroll-workbook/service";

export type PayrollSimulatorStatus =
  | "APROBADO"
  | "FALLIDO"
  | "PARCIAL"
  | "NO_EJECUTADO";

export interface PayrollSimulatorResult {
  numero: number;
  situacion: string;
  datosEntrada: unknown;
  reglaValidada: string;
  resultadoEsperado: unknown;
  resultadoObtenido: unknown;
  estado: PayrollSimulatorStatus;
  evidencia: string;
  observaciones: string;
}

export interface PayrollSimulatorTotals {
  aprobados: number;
  fallidos: number;
  parciales: number;
  noEjecutados: number;
  porcentajeCumplimiento: number;
}

const PERIOD = {
  type: "PAGO" as const,
  startDate: "2026-07-16",
  endDate: "2026-08-15",
  label: "Remuneraciones agosto de 2026 · 16 de julio al 15 de agosto de 2026",
};
const DAYS = calendarDaysBetween(PERIOD.startDate, PERIOD.endDate);
const WORKDAY = "2026-08-03";
const SECOND_WORKDAY = "2026-08-04";
const SATURDAY = "2026-08-08";
const SUNDAY = "2026-08-09";
const HOLIDAY = "2026-07-16";
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

function day(
  statusCode = "P",
  patch: Partial<AttendanceExportDay> = {}
): AttendanceExportDay {
  return {
    statusCode,
    recordedMinutes: 0,
    lateDetectedMinutes: 0,
    lateMinutes: 0,
    earlyDepartureDetectedMinutes: 0,
    earlyDepartureMinutes: 0,
    overtime50Minutes: 0,
    overtime100Minutes: 0,
    overtime50CandidateMinutes: 0,
    overtime100CandidateMinutes: 0,
    bonusAmount: 0,
    lateDecisionPending: false,
    earlyDepartureDecisionPending: false,
    overtime50DecisionPending: false,
    overtime100DecisionPending: false,
    missingPunchPending: false,
    absenceDecisionPending: false,
    ...patch,
  };
}

function worker(
  patch: Partial<AttendanceExportWorker> & Pick<AttendanceExportWorker, "employeeId" | "employeeCode">
): AttendanceExportWorker {
  const { employeeId, employeeCode, ...overrides } = patch;
  const scheduledDates = new Set(DAYS.filter((date) => !isWeekend(date) && date !== HOLIDAY));
  const records = new Map<string, AttendanceExportDay>();
  for (const date of scheduledDates) records.set(date, day());
  return {
    employeeId,
    employeeCode,
    employeeRut: "FICTICIO-001",
    workerName: "PERSONA FICTICIA 001",
    area: "PRODUCTION",
    costCenter: "CC-FICTICIO",
    days: records,
    hireDate: null,
    currentlyActive: true,
    scheduledWeekdays: new Set([1, 2, 3, 4, 5]),
    scheduleCoveredDates: new Set(DAYS),
    scheduledDates,
    exemptDates: new Set<string>(),
    scheduleLabel: "L-V 08:00-17:00",
    ...overrides,
  };
}

function dataFor(
  workers: AttendanceExportWorker[],
  patch: Partial<AttendanceExportData> = {}
): AttendanceExportData {
  return {
    period: PERIOD,
    days: DAYS,
    workers,
    holidays: new Set([HOLIDAY]),
    reportingPeriodStatus: "IN_REVIEW",
    ruleEngineProblemDates: new Set<string>(),
    companyId: COMPANY_A,
    ...patch,
  };
}

function workbookFor(
  workers: AttendanceExportWorker[],
  patch: Partial<AttendanceExportData> = {}
): Uint8Array {
  return buildAttendanceExportWorkbook(dataFor(workers, patch));
}

function readBook(bytes: Uint8Array): XLSX.WorkBook {
  return XLSX.read(bytes, {
    type: "array",
    cellFormula: true,
    cellStyles: true,
    cellDates: false,
  });
}

function cellValue(book: XLSX.WorkBook, sheet: string, ref: string): unknown {
  return book.Sheets[sheet]?.[ref]?.v ?? null;
}

function matrixCellRef(date: string, row = 6): string {
  return `${XLSX.utils.encode_col(5 + DAYS.indexOf(date))}${row}`;
}

function allSheetText(book: XLSX.WorkBook, sheetName: string): string {
  const sheet = book.Sheets[sheetName];
  if (!sheet) return "";
  return XLSX.utils
    .sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false })
    .flat()
    .map(String)
    .join("\n");
}

function compactOvertime(result: PayrollOvertimeResult): Record<string, unknown> {
  return {
    tasa: result.rate,
    minutosReales: result.realMinutes,
    minutosPagables: result.payableMinutes,
    bonoClp: result.bonusClp,
    bloqueado: result.blocked,
    alertas: result.warnings,
  };
}

function exactResult(
  numero: number,
  situacion: string,
  datosEntrada: unknown,
  reglaValidada: string,
  resultadoEsperado: unknown,
  resultadoObtenido: unknown,
  ok: boolean,
  evidencia: string,
  observaciones = "Sin correcciones dentro del ejecutor; informa el comportamiento del código actual."
): PayrollSimulatorResult {
  return {
    numero,
    situacion,
    datosEntrada,
    reglaValidada,
    resultadoEsperado,
    resultadoObtenido,
    estado: ok ? "APROBADO" : "FALLIDO",
    evidencia,
    observaciones,
  };
}

function explicitResult(
  numero: number,
  situacion: string,
  datosEntrada: unknown,
  reglaValidada: string,
  resultadoEsperado: unknown,
  resultadoObtenido: unknown,
  estado: Extract<PayrollSimulatorStatus, "PARCIAL" | "NO_EJECUTADO" | "FALLIDO">,
  evidencia: string,
  observaciones: string
): PayrollSimulatorResult {
  return {
    numero,
    situacion,
    datosEntrada,
    reglaValidada,
    resultadoEsperado,
    resultadoObtenido,
    estado,
    evidencia,
    observaciones,
  };
}

async function simulateCloseAndReopenLifecycle(): Promise<{
  actual: Record<string, unknown>;
  executableChecksPassed: boolean;
}> {
  const periodId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const baseVersionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const snapshotVersionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const operationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const stored: Array<{ path: string; bytes: Uint8Array; metadata: Record<string, string> }> = [];
  const calls: string[] = [];
  const revisions = [41, 41];
  const closeClient = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { filters[column] = value; return query; },
        is(column: string, value: null) { filters[column] = value; return query; },
        order() { return query; },
        limit() { return query; },
        then<TResult1 = unknown, TResult2 = never>(
          onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ) {
          const response = table === "payroll_workbook_conflicts"
            ? { data: [], error: null }
            : { data: [], error: null };
          return Promise.resolve(response).then(onfulfilled, onrejected);
        },
        async maybeSingle() {
          if (table === "reporting_periods") {
            return { data: { id: periodId, period_start: PERIOD.startDate, period_end: PERIOD.endDate, status: "READY_TO_CLOSE", closed_at: null }, error: null };
          }
          if (table === "payroll_workbook_versions") {
            return { data: { id: baseVersionId, content_sha256: "a".repeat(64), file_size: 64, storage_path: `${COMPANY_A}/${PERIOD.startDate}_${PERIOD.endDate}/accepted.xlsx` }, error: null };
          }
          return { data: null, error: { message: `Tabla inesperada ${table}` } };
        },
      };
      return query;
    },
    storage: {
      from() {
        return {
          async upload(path: string, bytes: Uint8Array, options: { metadata: Record<string, string> }) {
            calls.push("storage.upload");
            stored.push({ path, bytes: bytes.slice(), metadata: { ...options.metadata } });
            return { error: null };
          },
          async remove() { calls.push("storage.remove"); return { error: null }; },
        };
      },
    },
    async rpc(name: string) {
      calls.push(`rpc.${name}`);
      if (name === "get_payroll_source_revision") return { data: revisions.shift() ?? 41, error: null };
      if (name === "prepare_payroll_period_close") return { data: operationId, error: null };
      if (name === "abort_payroll_period_close") return { data: true, error: null };
      return { data: null, error: { message: `RPC inesperado ${name}` } };
    },
  };
  const snapshotBytes = makeMiniWorkbook();
  const closeData: AttendanceExportData = {
    period: PERIOD,
    days: [],
    workers: [],
    holidays: new Set(),
    reportingPeriodStatus: "READY_TO_CLOSE",
    ruleEngineProblemDates: new Set(),
    companyId: COMPANY_A,
  };
  const closeDependencies: PayrollPeriodCloseDependencies = {
    buildExportData: async () => ({ ...closeData }),
    buildWorkbook: () => snapshotBytes,
    getReadiness: () => ({ ready: true, pendingCount: 0, issues: [] }),
    loadAdjustments: async () => [],
    finalizePreparedClose: async (input) => {
      calls.push("trusted.finalize");
      const saved = stored.at(-1);
      if (!saved || saved.path !== input.storagePath || saved.bytes.byteLength !== input.expectedFileSize) {
        throw new Error("El snapshot ficticio no coincide con la reserva.");
      }
      return snapshotVersionId;
    },
    randomUuid: () => operationId,
  };

  const closed = await closePayrollPeriodWithSnapshot(
    closeClient as unknown as SupabaseClient<Database>,
    { companyId: COMPANY_A, reportingPeriodId: periodId, callerRole: "ADMIN_RRHH" },
    closeDependencies,
  );
  const exactBytes = stored.length === 1
    && Buffer.from(stored[0].bytes).equals(Buffer.from(snapshotBytes));

  let reopenedPatch: Record<string, unknown> | null = null;
  const reopenClient = {
    from() {
      const query = {
        update(patch: Record<string, unknown>) { reopenedPatch = { ...patch }; return query; },
        eq() { return query; },
        async select() { return { data: [{ id: periodId }], error: null }; },
      };
      return query;
    },
  };
  await transitionReportingPeriod(
    reopenClient as unknown as SupabaseClient<Database>,
    {
      periodId,
      from: "CLOSED",
      to: "REOPENED",
      actorId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      reopenReason: "Corrección ficticia",
    },
  );
  const capturedReopen = reopenedPatch as { reopen_reason?: unknown } | null;
  const reopenReason = capturedReopen?.reopen_reason;
  const executableChecksPassed = closed.snapshotVersionId === snapshotVersionId
    && exactBytes
    && reopenReason === "Corrección ficticia"
    && calls.indexOf("rpc.prepare_payroll_period_close") < calls.indexOf("storage.upload")
    && calls.indexOf("storage.upload") < calls.indexOf("trusted.finalize")
    && !calls.includes("storage.remove");

  return {
    actual: {
      cierreAplicacionEjecutado: true,
      snapshotVersionId: closed.snapshotVersionId,
      bytesSubidosIgualesAlSnapshot: exactBytes,
      ordenReservaSubidaVerificacion: calls,
      reaperturaAplicacionEjecutada: true,
      motivoReaperturaGuardado: reopenReason ?? null,
      versionAnteriorIntacta: "sin evidencia persistente",
      descargaExactaDesdeStorage: "no ejecutada",
      cicloPostgresStorageAislado: "no ejecutado",
      nuevaVersionPersistidaTrasReapertura: "pendiente de Supabase aislada",
    },
    executableChecksPassed,
  };
}

function makeMiniWorkbook(input: {
  periodStart?: string;
  schema?: string;
  companyId?: string;
  value?: number;
  formula?: string;
} = {}): Uint8Array {
  const book = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    ["Título"],
    [],
    [],
    [],
    [
      "Estado",
      "RUT",
      "Nombre completo",
      "Área",
      "Centro de costo",
      "Jornada",
      "Días con presencia",
      "Horas ordinarias registradas",
      "HH50 pagables",
      "HH100 pagables",
      "Atrasos descontables",
      "Salidas anticipadas descontables",
      "Días con bono",
      "Bono total",
      "Pendientes",
      "Observaciones",
      "HH50 reales",
      "Ajuste HH50 (minutos)",
      "Motivo ajuste HH50",
      "HH100 reales",
      "Ajuste HH100 (minutos)",
      "Motivo ajuste HH100",
      "Bono HE automático",
      "Ajuste bono (CLP)",
      "Motivo ajuste bono",
      "Fechas de bono",
      "Fechas pendientes",
      "Código Workera",
      "Identificador técnico",
      "HH50 aprobado automático",
      "HH100 aprobado automático",
    ],
    [
      "REVISAR",
      "FICTICIO-001",
      "PERSONA FICTICIA 001",
      "Producción",
      "CC-FICTICIO",
      "08:00-17:00",
      1,
      8 / 24,
      input.value ?? 0,
      0,
      0,
      0,
      0,
      0,
      0,
      "",
      0,
      0,
      "",
      0,
      0,
      "",
      0,
      0,
      "",
      "",
      "",
      "WK-FICTICIO-001",
      "99999999-9999-4999-8999-999999999999",
      0,
      0,
    ],
  ]);
  const formulaCell = summary.I6;
  if (formulaCell) formulaCell.f = input.formula ?? "AD6+R6/1440";
  const bonusFormulaCell = summary.N6;
  if (bonusFormulaCell) bonusFormulaCell.f = "W6+X6";
  summary["!cols"] = Array.from({ length: 31 }, () => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(book, summary, "RESUMEN_NOMINA");
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([["Pendientes"]]),
    "CONTROL_PENDIENTES"
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([["Matriz"]]),
    "MATRIZ_DIARIA_SABANA"
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Esquema", input.schema ?? "GESTORA_PRENOMINA_2026_V2"],
      ["Empresa", input.companyId ?? COMPANY_A],
      ["Tipo de período", "PAGO"],
      ["Inicio", input.periodStart ?? PERIOD.startDate],
      ["Fin", PERIOD.endDate],
      ["Mes de remuneración", "2026-08"],
      ["Versión base", "2"],
    ]),
    "_GESTORA_TECNICA"
  );
  book.Workbook = {
    Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 0 }, { Hidden: 2 }],
  };
  const written = XLSX.write(book, {
    type: "array",
    bookType: "xlsx",
    compression: true,
  }) as Uint8Array | ArrayBuffer;
  return written instanceof Uint8Array ? written : new Uint8Array(written);
}

function rewriteWorkbook(
  bytes: Uint8Array,
  mutate: (book: XLSX.WorkBook) => void
): Uint8Array {
  const book = readBook(bytes);
  mutate(book);
  const written = XLSX.write(book, {
    type: "array",
    bookType: "xlsx",
    compression: true,
    cellStyles: true,
  }) as Uint8Array | ArrayBuffer;
  return written instanceof Uint8Array ? written : new Uint8Array(written);
}

function rejectionMessage(operation: () => unknown): string {
  try {
    operation();
    return "NO_RECHAZADO";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type InsertCapture = Record<string, unknown>;

function decisionClient(
  sourceTable: "late_arrival_records" | "early_departure_records",
  decisionTable: "late_arrival_decisions" | "early_departure_decisions",
  detectedMinutes: number,
  capture: InsertCapture[]
): SupabaseClient<Database> {
  const client = {
    from(table: string) {
      if (table === sourceTable) {
        const chain = {
          select() {
            return chain;
          },
          eq() {
            return chain;
          },
          async single() {
            return { data: { detected_minutes: detectedMinutes }, error: null };
          },
        };
        return chain;
      }
      if (table === decisionTable) {
        return {
          insert(payload: InsertCapture) {
            capture.push(payload);
            return {
              select() {
                return {
                  async single() {
                    return { data: { id: `decision-${capture.length}` }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`Tabla inesperada en simulador: ${table}`);
    },
  };
  return client as unknown as SupabaseClient<Database>;
}

async function simulateLateDecisions(minutes: number): Promise<InsertCapture[]> {
  const captured: InsertCapture[] = [];
  const client = decisionClient(
    "late_arrival_records",
    "late_arrival_decisions",
    minutes,
    captured
  );
  await decideLateArrival(client, {
    lateArrivalRecordId: "late-ficticio-justificado",
    justified: true,
    reason: "Permiso ficticio autorizado",
  });
  await decideLateArrival(client, {
    lateArrivalRecordId: "late-ficticio-descontable",
    justified: false,
    reason: "Atraso ficticio sin justificar",
  });
  return captured;
}

async function simulateEarlyDepartureDecisions(minutes: number): Promise<InsertCapture[]> {
  const captured: InsertCapture[] = [];
  const client = decisionClient(
    "early_departure_records",
    "early_departure_decisions",
    minutes,
    captured
  );
  await decideEarlyDepartureOther(client, {
    earlyDepartureRecordId: "early-ficticio-justificado",
    reasonCategory: "OTHER_JUSTIFIED",
    reason: "Salida ficticia autorizada",
  });
  await decideEarlyDepartureOther(client, {
    earlyDepartureRecordId: "early-ficticio-descontable",
    reasonCategory: "UNJUSTIFIED",
    reason: "Salida ficticia sin justificar",
  });
  return captured;
}

function changesAt(
  changes: PayrollWorkbookChange[],
  refs: readonly string[]
): PayrollWorkbookChange[] {
  const wanted = new Set(refs);
  return changes.filter((change) => wanted.has(`${change.sheet}!${change.cell}`));
}

/**
 * Ejecuta los 30 escenarios textuales del prompt maestro usando únicamente
 * identidades y marcas ficticias. No abre conexiones de red ni bases de datos.
 * Los casos que exigen persistencia transaccional quedan explícitos y no se
 * convierten en aprobados mediante inspección estática.
 */
export async function runPayrollSimulators(): Promise<PayrollSimulatorResult[]> {
  const results: PayrollSimulatorResult[] = [];

  const normalWorker = worker({ employeeId: "sim-001", employeeCode: "SIM-001" });
  normalWorker.days.set(WORKDAY, day("P", { recordedMinutes: 540 }));
  const normalWorkbook = readBook(workbookFor([normalWorker]));
  const normalActual = {
    codigo: cellValue(normalWorkbook, "MATRIZ_DIARIA_SABANA", matrixCellRef(WORKDAY)),
    horasOrdinariasExcel: cellValue(normalWorkbook, "RESUMEN_NOMINA", "H6"),
    hh50Excel: cellValue(normalWorkbook, "RESUMEN_NOMINA", "I6"),
    hh100Excel: cellValue(normalWorkbook, "RESUMEN_NOMINA", "J6"),
    bonoClp: cellValue(normalWorkbook, "RESUMEN_NOMINA", "N6"),
    pendientes: cellValue(normalWorkbook, "RESUMEN_NOMINA", "O6"),
  };
  results.push(
    exactResult(
      1,
      "Día normal",
      { fecha: WORKDAY, entrada: "08:00", salida: "17:00", codigo: "P" },
      "Un día normal conserva P, registra la jornada ordinaria y no crea HE, bono ni pendientes.",
      {
        codigo: "P",
        horasOrdinariasExcel: 9 / 24,
        hh50Excel: 0,
        hh100Excel: 0,
        bonoClp: 0,
        pendientes: 0,
      },
      normalActual,
      normalActual.codigo === "P" &&
        normalActual.horasOrdinariasExcel === 9 / 24 &&
        normalActual.hh50Excel === 0 &&
        normalActual.hh100Excel === 0 &&
        normalActual.bonoClp === 0 &&
        normalActual.pendientes === 0,
      "buildAttendanceExportWorkbook; RESUMEN_NOMINA!H6:N6 y MATRIZ_DIARIA_SABANA para 2026-08-03",
      "La entrada es completamente ficticia. El resultado revela si la columna de horas ordinarias se calcula realmente."
    )
  );

  const overtimeInput = {
    area: "PRODUCTION" as const,
    dayOfWeek: 2,
    isHoliday: false,
  };
  const minute59 = evaluatePayrollOvertime({
    ...overtimeInput,
    realMinutes: 59,
    approvedMinutes: 59,
  });
  const minute59Worker = worker({ employeeId: "sim-002", employeeCode: "SIM-002" });
  minute59Worker.days.set(
    WORKDAY,
    day("P", {
      recordedMinutes: 539,
      overtime50CandidateMinutes: 59,
      overtime50DecisionPending: true,
    })
  );
  const minute59WorkbookBytes = workbookFor([minute59Worker]);
  const minute59Workbook = readBook(minute59WorkbookBytes);
  const minute59Archive = unzipSync(minute59WorkbookBytes);
  const minute59PresentationXml = [
    minute59Archive["xl/worksheets/sheet1.xml"],
    minute59Archive["xl/styles.xml"],
  ]
    .map((entry) => (entry === undefined ? "" : strFromU8(entry)))
    .join("\n");
  const minute59Actual = {
    evaluador: compactOvertime(minute59),
    libro: {
      estado: cellValue(minute59Workbook, "RESUMEN_NOMINA", "A6"),
      pendientes: cellValue(minute59Workbook, "RESUMEN_NOMINA", "O6"),
      incidencia59Visible:
        allSheetText(minute59Workbook, "CONTROL_PENDIENTES").includes("HH 50% sin decisión") &&
        allSheetText(minute59Workbook, "CONTROL_PENDIENTES").includes("59"),
      reglaVisualRoja: minute59PresentationXml.includes("F4CCCC") &&
        minute59PresentationXml.includes("BLOQUEADO"),
    },
  };
  const minute59ChecksPass = minute59.realMinutes === 59 &&
    minute59.payableMinutes === 0 &&
    minute59.warnings.length > 0 &&
    minute59Actual.libro.estado === "BLOQUEADO" &&
    typeof minute59Actual.libro.pendientes === "number" &&
    minute59Actual.libro.pendientes >= 1 &&
    minute59Actual.libro.incidencia59Visible &&
    minute59Actual.libro.reglaVisualRoja;
  results.push(
    explicitResult(
      2,
      "59 minutos extra: rojo, sin pago automático",
      { ...overtimeInput, minutosReales: 59, minutosAprobados: 59 },
      "Menos de una hora debe alertar en rojo y no ser pagable automáticamente.",
      { minutosReales: 59, minutosPagables: 0, alerta: true },
      minute59Actual,
      minute59ChecksPass ? "PARCIAL" : "FALLIDO",
      "evaluatePayrollOvertime y buildAttendanceExportWorkbook; RESUMEN_NOMINA!A6/O6, CONTROL_PENDIENTES y XML de formato condicional",
      minute59ChecksPass
        ? "Se verificaron el bloqueo, cero minutos pagables y la existencia de una regla roja; no se renderizó visualmente este caso individual para demostrar la asociación exacta del color con su incidencia."
        : "Falló una comprobación ejecutable de minutos, alerta o bloqueo."
    )
  );

  const minute60 = evaluatePayrollOvertime({
    ...overtimeInput,
    realMinutes: 60,
    approvedMinutes: 60,
  });
  results.push(
    exactResult(
      3,
      "1:00 aprobada: paga una hora, sin bono",
      { ...overtimeInput, minutosReales: 60, minutosAprobados: 60 },
      "Entre 1:00 y 1:59 puede aprobarse y no genera bono.",
      { tasa: "HH50", minutosPagables: 60, bonoClp: 0 },
      compactOvertime(minute60),
      minute60.rate === "HH50" && minute60.payableMinutes === 60 && minute60.bonusClp === 0,
      "evaluatePayrollOvertime({ realMinutes: 60, approvedMinutes: 60 })"
    )
  );

  const minute119 = evaluatePayrollOvertime({
    ...overtimeInput,
    realMinutes: 119,
    approvedMinutes: 119,
  });
  results.push(
    exactResult(
      4,
      "1:59 aprobada: sin bono",
      { ...overtimeInput, minutosReales: 119, minutosAprobados: 119 },
      "1:59 es pagable con aprobación, pero todavía no genera bono.",
      { minutosPagables: 119, bonoClp: 0 },
      compactOvertime(minute119),
      minute119.payableMinutes === 119 && minute119.bonusClp === 0,
      "evaluatePayrollOvertime({ realMinutes: 119, approvedMinutes: 119 })"
    )
  );

  const minute120 = evaluatePayrollOvertime({
    ...overtimeInput,
    realMinutes: 120,
    approvedMinutes: 120,
  });
  results.push(
    exactResult(
      5,
      "2:00 aprobadas: bono diario de $1.000",
      { ...overtimeInput, minutosReales: 120, minutosAprobados: 120 },
      "Dos horas aprobadas pagan 2:00 y generan exactamente $1.000.",
      { minutosPagables: 120, bonoClp: 1_000 },
      compactOvertime(minute120),
      minute120.payableMinutes === 120 && minute120.bonusClp === 1_000,
      "evaluatePayrollOvertime({ realMinutes: 120, approvedMinutes: 120 })"
    )
  );

  const minute121 = evaluatePayrollOvertime({
    ...overtimeInput,
    realMinutes: 121,
    approvedMinutes: 121,
  });
  results.push(
    exactResult(
      6,
      "2:01 con tope",
      { ...overtimeInput, minutosReales: 121, minutosAprobados: 121 },
      "Conserva 2:01 reales, paga 2:00, genera $1.000 y alerta por el tope.",
      { minutosReales: 121, minutosPagables: 120, bonoClp: 1_000, alerta: true },
      compactOvertime(minute121),
      minute121.realMinutes === 121 &&
        minute121.payableMinutes === 120 &&
        minute121.bonusClp === 1_000 &&
        minute121.warnings.length > 0,
      "evaluatePayrollOvertime({ realMinutes: 121, approvedMinutes: 121 })"
    )
  );

  const manyHours = evaluatePayrollOvertime({
    ...overtimeInput,
    realMinutes: 600,
    approvedMinutes: 600,
  });
  results.push(
    exactResult(
      7,
      "Muchas horas en un día",
      { ...overtimeInput, minutosReales: 600, minutosAprobados: 600 },
      "Más horas no aumentan el bono diario por encima de $1.000.",
      { bonoClp: 1_000, maximoDiarioClp: 1_000 },
      compactOvertime(manyHours),
      manyHours.bonusClp === 1_000,
      "evaluatePayrollOvertime({ realMinutes: 600, approvedMinutes: 600 })"
    )
  );

  const bonusDay1 = evaluatePayrollOvertime({
    ...overtimeInput,
    realMinutes: 120,
    approvedMinutes: 120,
  });
  const bonusDay2 = evaluatePayrollOvertime({
    ...overtimeInput,
    realMinutes: 180,
    approvedMinutes: 180,
  });
  const twoDayBonusWorker = worker({ employeeId: "sim-008", employeeCode: "SIM-008" });
  twoDayBonusWorker.days.set(WORKDAY, day("P", {
    overtime50CandidateMinutes: 120,
    overtime50Minutes: 120,
    bonusAmount: bonusDay1.bonusClp,
  }));
  twoDayBonusWorker.days.set(SECOND_WORKDAY, day("P", {
    overtime50CandidateMinutes: 180,
    overtime50Minutes: 120,
    bonusAmount: bonusDay2.bonusClp,
  }));
  const twoDayBonusBook = readBook(workbookFor([twoDayBonusWorker]));
  const twoDayBonusActual = {
    dia1: compactOvertime(bonusDay1),
    dia2: compactOvertime(bonusDay2),
    diasConBonoExcel: cellValue(twoDayBonusBook, "RESUMEN_NOMINA", "M6"),
    bonoTotalClpExcel: cellValue(twoDayBonusBook, "RESUMEN_NOMINA", "N6"),
    fechasBonoExcel: cellValue(twoDayBonusBook, "RESUMEN_NOMINA", "Z6"),
  };
  results.push(
    exactResult(
      8,
      "Dos días elegibles",
      {
        dias: [
          { fecha: WORKDAY, minutos: 120 },
          { fecha: SECOND_WORKDAY, minutos: 180 },
        ],
      },
      "El bono es diario: dos fechas elegibles acumulan $2.000 en el período.",
      { diasConBono: 2, bonoTotalClp: 2_000 },
      twoDayBonusActual,
      bonusDay1.bonusClp === 1_000 &&
        bonusDay2.bonusClp === 1_000 &&
        twoDayBonusActual.diasConBonoExcel === 2 &&
        twoDayBonusActual.bonoTotalClpExcel === 2_000 &&
        String(twoDayBonusActual.fechasBonoExcel).includes("03/08") &&
        String(twoDayBonusActual.fechasBonoExcel).includes("04/08"),
      "evaluatePayrollOvertime y agregación real de buildAttendanceExportWorkbook; RESUMEN_NOMINA!M6,N6,Z6"
    )
  );

  const saturdayProduction = evaluatePayrollOvertime({
    area: "PRODUCTION",
    dayOfWeek: 6,
    isHoliday: false,
    realMinutes: 180,
    approvedMinutes: 180,
  });
  const saturdayInstallation = evaluatePayrollOvertime({
    area: "INSTALLATION",
    dayOfWeek: 6,
    isHoliday: false,
    realMinutes: 180,
    approvedMinutes: 180,
  });
  results.push(
    exactResult(
      9,
      "Sábado Producción e Instalación",
      { fecha: SATURDAY, minutosReales: 180, minutosAprobados: 180, areas: ["PRODUCTION", "INSTALLATION"] },
      "En sábado ambas áreas usan HH50 y tienen máximo pagable de 2 horas.",
      { produccion: { tasa: "HH50", pagables: 120 }, instalacion: { tasa: "HH50", pagables: 120 } },
      { produccion: compactOvertime(saturdayProduction), instalacion: compactOvertime(saturdayInstallation) },
      saturdayProduction.rate === "HH50" &&
        saturdayProduction.payableMinutes === 120 &&
        saturdayInstallation.rate === "HH50" &&
        saturdayInstallation.payableMinutes === 120,
      "Dos ejecuciones de evaluatePayrollOvertime con dayOfWeek=6"
    )
  );

  const holiday360 = evaluatePayrollOvertime({
    area: "PRODUCTION",
    dayOfWeek: 4,
    isHoliday: true,
    realMinutes: 360,
    approvedMinutes: 360,
  });
  results.push(
    exactResult(
      10,
      "Festivo: HH100, máximo 6 horas",
      { fecha: HOLIDAY, area: "PRODUCTION", minutosReales: 360, minutosAprobados: 360 },
      "El festivo usa HH100 y admite hasta 6:00 pagables.",
      { tasa: "HH100", minutosPagables: 360 },
      compactOvertime(holiday360),
      holiday360.rate === "HH100" && holiday360.payableMinutes === 360,
      "evaluatePayrollOvertime({ isHoliday: true, realMinutes: 360 })"
    )
  );

  const holiday361 = evaluatePayrollOvertime({
    area: "INSTALLATION",
    dayOfWeek: 4,
    isHoliday: true,
    realMinutes: 361,
    approvedMinutes: 361,
  });
  results.push(
    exactResult(
      11,
      "Festivo 6:01",
      { fecha: HOLIDAY, area: "INSTALLATION", minutosReales: 361, minutosAprobados: 361 },
      "Conserva 6:01 reales, paga 6:00 y alerta.",
      { tasa: "HH100", minutosReales: 361, minutosPagables: 360, alerta: true },
      compactOvertime(holiday361),
      holiday361.rate === "HH100" &&
        holiday361.realMinutes === 361 &&
        holiday361.payableMinutes === 360 &&
        holiday361.warnings.length > 0,
      "evaluatePayrollOvertime({ isHoliday: true, realMinutes: 361 })"
    )
  );

  const sundayInstallation = evaluatePayrollOvertime({
    area: "INSTALLATION",
    dayOfWeek: 0,
    isHoliday: false,
    realMinutes: 480,
    approvedMinutes: 480,
  });
  const sundayInstallationChecksPass = sundayInstallation.rate === "HH100" &&
    sundayInstallation.payableMinutes === 480 &&
    sundayInstallation.bonusClp === 1_000 &&
    !sundayInstallation.blocked;
  results.push(
    explicitResult(
      12,
      "Domingo Instalación",
      { fecha: SUNDAY, area: "INSTALLATION", minutosReales: 480, minutosAprobadosInyectados: 480 },
      "Domingo en Instalación usa HH100, no tiene tope fijo y exige aprobación competente.",
      { tasa: "HH100", minutosPagables: 480, bonoClp: 1_000 },
      compactOvertime(sundayInstallation),
      sundayInstallationChecksPass ? "PARCIAL" : "FALLIDO",
      "evaluatePayrollOvertime({ area: INSTALLATION, dayOfWeek: 0, approvedMinutes: 480 })",
      sundayInstallationChecksPass
        ? "Se verificaron HH100, ausencia de tope y bono. La competencia real del supervisor requiere ejecutar las políticas/RLS en Supabase aislada."
        : "Falló una comprobación ejecutable de clasificación, tope o bono."
    )
  );

  const sundayProduction = evaluatePayrollOvertime({
    area: "PRODUCTION",
    dayOfWeek: 0,
    isHoliday: false,
    realMinutes: 120,
    approvedMinutes: 120,
  });
  results.push(
    exactResult(
      13,
      "Domingo Producción bloqueado",
      { fecha: SUNDAY, area: "PRODUCTION", minutosReales: 120, minutosAprobados: 120 },
      "Producción en domingo queda bloqueada y no paga horas.",
      { bloqueado: true, minutosPagables: 0 },
      compactOvertime(sundayProduction),
      sundayProduction.blocked && sundayProduction.payableMinutes === 0,
      "evaluatePayrollOvertime({ area: PRODUCTION, dayOfWeek: 0 })"
    )
  );

  const lateDecisions = await simulateLateDecisions(17);
  const lateActual = lateDecisions.map((item) => ({
    justified: item.justified,
    payrollMinutes: item.payroll_minutes,
    payrollEffect: item.payroll_effect,
    reason: item.reason,
  }));
  results.push(
    exactResult(
      14,
      "Atraso justificado y descontable",
      { minutosDetectados: 17, casos: ["justificado", "no justificado"], identidad: "ficticia" },
      "Justificado conserva el original y descuenta 0; no justificado descuenta los minutos detectados, ambos con motivo.",
      [
        { justified: true, payrollMinutes: 0, payrollEffect: "DO_NOT_DEDUCT" },
        { justified: false, payrollMinutes: 17, payrollEffect: "DEDUCT" },
      ],
      lateActual,
      lateActual.length === 2 &&
        lateActual[0].justified === true &&
        lateActual[0].payrollMinutes === 0 &&
        lateActual[0].payrollEffect === "DO_NOT_DEDUCT" &&
        lateActual[1].justified === false &&
        lateActual[1].payrollMinutes === 17 &&
        lateActual[1].payrollEffect === "DEDUCT" &&
        lateActual.every((item) => typeof item.reason === "string" && item.reason.length > 0),
      "decideLateArrival con cliente Supabase ficticio en memoria; payloads insertados capturados"
    )
  );

  const earlyDecisions = await simulateEarlyDepartureDecisions(23);
  const earlyActual = earlyDecisions.map((item) => ({
    reasonCategory: item.reason_category,
    payrollMinutes: item.payroll_minutes,
    payrollEffect: item.payroll_effect,
    reason: item.reason,
  }));
  results.push(
    exactResult(
      15,
      "Salida anticipada justificada y descontable",
      { minutosDetectados: 23, casos: ["justificada", "injustificada"], identidad: "ficticia" },
      "Justificada descuenta 0; injustificada descuenta los minutos detectados, conservando motivo y categoría.",
      [
        { reasonCategory: "OTHER_JUSTIFIED", payrollMinutes: 0, payrollEffect: "DO_NOT_DEDUCT" },
        { reasonCategory: "UNJUSTIFIED", payrollMinutes: 23, payrollEffect: "DEDUCT" },
      ],
      earlyActual,
      earlyActual.length === 2 &&
        earlyActual[0].reasonCategory === "OTHER_JUSTIFIED" &&
        earlyActual[0].payrollMinutes === 0 &&
        earlyActual[0].payrollEffect === "DO_NOT_DEDUCT" &&
        earlyActual[1].reasonCategory === "UNJUSTIFIED" &&
        earlyActual[1].payrollMinutes === 23 &&
        earlyActual[1].payrollEffect === "DEDUCT" &&
        earlyActual.every((item) => typeof item.reason === "string" && item.reason.length > 0),
      "decideEarlyDepartureOther con cliente Supabase ficticio en memoria; payloads insertados capturados"
    )
  );

  const permissionWorker = worker({ employeeId: "sim-016", employeeCode: "SIM-016" });
  const permissionCodes = ["F-P", "F-J", "P-L", "P-M"];
  const permissionDates = ["2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06"];
  permissionDates.forEach((dateValue, index) => {
    permissionWorker.days.set(dateValue, day(permissionCodes[index]));
  });
  const permissionBook = readBook(workbookFor([permissionWorker]));
  const permissionActual = {
    codigos: permissionDates.map((dateValue) =>
      cellValue(permissionBook, "MATRIZ_DIARIA_SABANA", matrixCellRef(dateValue))
    ),
    atrasosDescontablesExcel: cellValue(permissionBook, "RESUMEN_NOMINA", "K6"),
    salidasDescontablesExcel: cellValue(permissionBook, "RESUMEN_NOMINA", "L6"),
  };
  results.push(
    exactResult(
      16,
      "F-P, F-J, P-L y P-M sin descuento",
      { fechas: permissionDates, codigos: permissionCodes },
      "Los cuatro códigos se mantienen separados y no generan descuento automático.",
      { codigos: permissionCodes, atrasosDescontablesExcel: 0, salidasDescontablesExcel: 0 },
      permissionActual,
      JSON.stringify(permissionActual.codigos) === JSON.stringify(permissionCodes) &&
        permissionActual.atrasosDescontablesExcel === 0 &&
        permissionActual.salidasDescontablesExcel === 0,
      "buildAttendanceExportWorkbook; MATRIZ_DIARIA_SABANA y RESUMEN_NOMINA!K6:L6"
    )
  );

  const leaveWorker = worker({ employeeId: "sim-017", employeeCode: "SIM-017" });
  const leaveCodes = ["V", "L", "L-M"];
  const leaveDates = ["2026-08-03", "2026-08-04", "2026-08-05"];
  leaveDates.forEach((dateValue, index) => leaveWorker.days.set(dateValue, day(leaveCodes[index])));
  const leaveBook = readBook(workbookFor([leaveWorker]));
  const leaveActual = leaveDates.map((dateValue) =>
    cellValue(leaveBook, "MATRIZ_DIARIA_SABANA", matrixCellRef(dateValue))
  );
  results.push(
    exactResult(
      17,
      "Vacaciones, licencia común y licencia mutual",
      { fechas: leaveDates, codigos: leaveCodes },
      "V, L y L-M permanecen como categorías separadas en la matriz diaria.",
      { codigos: leaveCodes },
      { codigos: leaveActual },
      JSON.stringify(leaveActual) === JSON.stringify(leaveCodes),
      "buildAttendanceExportWorkbook; celdas diarias de MATRIZ_DIARIA_SABANA"
    )
  );

  const incompleteWorker = worker({ employeeId: "sim-018", employeeCode: "SIM-018" });
  incompleteWorker.days.set(WORKDAY, day("?", { missingPunchPending: true }));
  const incompleteBook = readBook(workbookFor([incompleteWorker]));
  const incompleteActual = {
    codigo: cellValue(incompleteBook, "MATRIZ_DIARIA_SABANA", matrixCellRef(WORKDAY)),
    estado: cellValue(incompleteBook, "RESUMEN_NOMINA", "A6"),
    pendientes: cellValue(incompleteBook, "RESUMEN_NOMINA", "O6"),
    controlContieneMarcacionIncompleta: allSheetText(incompleteBook, "CONTROL_PENDIENTES").includes("Marcación incompleta"),
  };
  results.push(
    exactResult(
      18,
      "Marcación incompleta ?",
      { fecha: WORKDAY, codigo: "?", missingPunchPending: true },
      "? debe resaltarse como dato no resuelto, crear pendiente y bloquear.",
      { codigo: "?", estado: "BLOQUEADO", pendientesMinimo: 1, incidenciaVisible: true },
      incompleteActual,
      incompleteActual.codigo === "?" &&
        incompleteActual.estado === "BLOQUEADO" &&
        typeof incompleteActual.pendientes === "number" &&
        incompleteActual.pendientes >= 1 &&
        incompleteActual.controlContieneMarcacionIncompleta,
      "buildAttendanceExportWorkbook; MATRIZ_DIARIA_SABANA, RESUMEN_NOMINA!A6/O6 y CONTROL_PENDIENTES"
    )
  );

  const alternateWorker = worker({
    employeeId: "sim-019",
    employeeCode: "SIM-019",
    scheduleLabel: "L-V 08:00-18:00",
    scheduleConfirmationPending: true,
  });
  const alternateBook = readBook(workbookFor([alternateWorker]));
  const pendingText = allSheetText(alternateBook, "CONTROL_PENDIENTES");
  const alternateActual = {
    jornadaMostrada: cellValue(alternateBook, "RESUMEN_NOMINA", "F6"),
    estado: cellValue(alternateBook, "RESUMEN_NOMINA", "A6"),
    alertaHorario: /horario|jornada/i.test(pendingText),
  };
  const alternateChecksPass = alternateActual.jornadaMostrada === "L-V 08:00-18:00" &&
    alternateActual.alertaHorario &&
    alternateActual.estado === "BLOQUEADO";
  results.push(
    explicitResult(
      19,
      "Horario distinto de 17:00",
      { jornadaEfectiva: "L-V 08:00-18:00", jornadaHabitualTermina: "17:00", banderaPendienteInyectada: true },
      "Una jornada distinta no se elige silenciosamente: debe alertar y solicitar confirmación de RR. HH.",
      { jornadaMostrada: "L-V 08:00-18:00", alertaHorario: true, bloqueadoHastaConfirmacion: true },
      alternateActual,
      alternateChecksPass ? "PARCIAL" : "FALLIDO",
      "buildAttendanceExportWorkbook; RESUMEN_NOMINA!A6/F6 y búsqueda de horario/jornada en CONTROL_PENDIENTES",
      alternateChecksPass
        ? "El libro muestra y bloquea el pendiente; el fixture inyecta la bandera. La detección y confirmación persistida exclusiva de RR. HH. requieren Supabase aislada."
        : "Falló una comprobación ejecutable de visualización o bloqueo."
    )
  );

  const adjustmentBase = makeMiniWorkbook();
  const adjustmentUpload = rewriteWorkbook(adjustmentBase, (book) => {
    const sheet = book.Sheets.RESUMEN_NOMINA;
    sheet.R6 = { t: "n", v: 30 };
    sheet.S6 = { t: "s", v: "Motivo ficticio ajuste HH50" };
    sheet.X6 = { t: "n", v: 250 };
    sheet.Y6 = { t: "s", v: "Motivo ficticio ajuste bono" };
  });
  const adjustmentPreview = comparePayrollWorkbooks(adjustmentBase, adjustmentUpload);
  const adjustmentChanges = changesAt(adjustmentPreview.changes, [
    "RESUMEN_NOMINA!R6",
    "RESUMEN_NOMINA!S6",
    "RESUMEN_NOMINA!X6",
    "RESUMEN_NOMINA!Y6",
  ]);
  const adjustmentByCell = new Map(adjustmentChanges.map((change) => [change.cell, change]));
  const validAdjustmentIssues = validatePayrollWorkbookBusinessChanges(adjustmentBase, adjustmentPreview.changes);
  const missingReasonUpload = rewriteWorkbook(adjustmentBase, (book) => {
    book.Sheets.RESUMEN_NOMINA.R6 = { t: "n", v: 30 };
  });
  const missingReasonPreview = comparePayrollWorkbooks(adjustmentBase, missingReasonUpload);
  const missingReasonIssues = validatePayrollWorkbookBusinessChanges(adjustmentBase, missingReasonPreview.changes);
  const adjustmentBaseBook = readBook(adjustmentBase);
  const trustedHh50OriginalMinutes = Number(cellValue(adjustmentBaseBook, "RESUMEN_NOMINA", "AD6")) * 1_440;
  const trustedBonusOriginalClp = Number(cellValue(adjustmentBaseBook, "RESUMEN_NOMINA", "W6"));
  const adjustmentActual = {
    cambios: adjustmentChanges.map((change) => ({
      celda: change.cell,
      nuevo: change.next,
      claveEstable: change.stableKey,
      consecuencia: change.consequence,
    })),
    formulaHH50: readBook(adjustmentUpload).Sheets.RESUMEN_NOMINA.I6?.f ?? null,
    formulaBono: readBook(adjustmentUpload).Sheets.RESUMEN_NOMINA.N6?.f ?? null,
    validacionConMotivos: validAdjustmentIssues,
    validacionSinMotivo: missingReasonIssues,
    conciliacionHH50Minutos: { original: trustedHh50OriginalMinutes, ajuste: 30, final: trustedHh50OriginalMinutes + 30 },
    conciliacionBonoClp: { original: trustedBonusOriginalClp, ajuste: 250, final: trustedBonusOriginalClp + 250 },
  };
  const adjustmentChecksPass = adjustmentChanges.length === 4 &&
    adjustmentChanges.every((change) => change.stableKey !== null && change.consequence === "AJUSTE_EMPRESARIAL") &&
    adjustmentByCell.get("S6")?.next === "Motivo ficticio ajuste HH50" &&
    adjustmentByCell.get("Y6")?.next === "Motivo ficticio ajuste bono" &&
    adjustmentActual.formulaHH50 === "AD6+R6/1440" &&
    adjustmentActual.formulaBono === "W6+X6" &&
    validAdjustmentIssues.length === 0 &&
    missingReasonIssues.some((issue) => issue.includes("motivo del ajuste HH50 es obligatorio")) &&
    adjustmentActual.conciliacionHH50Minutos.final === 30 &&
    adjustmentActual.conciliacionBonoClp.final === 250;
  results.push(
    explicitResult(
      20,
      "Ajustes manuales de horas y bono con motivo",
      { ajusteHH50Minutos: 30, motivoHH50: "ficticio", ajusteBonoClp: 250, motivoBono: "ficticio" },
      "Los ajustes reconocidos exigen motivo, quedan ligados a una clave estable y el valor final reconcilia original + ajuste.",
      { celdasReconocidas: ["R6", "S6", "X6", "Y6"], cambiosEmpresariales: 4, motivosPresentes: true },
      adjustmentActual,
      adjustmentChecksPass ? "PARCIAL" : "FALLIDO",
      "comparePayrollWorkbooks y validatePayrollWorkbookBusinessChanges; cuatro celdas editadas, rechazo sin motivo y conciliación confiable",
      adjustmentChecksPass
        ? "La edición, motivos, fórmulas y conciliación se ejecutaron en memoria. La persistencia auditable de actor, versión y cambios exige Supabase aislada."
        : "Falló al menos una comprobación ejecutable de ajustes manuales."
    )
  );

  const negative = evaluatePayrollOvertime({
    area: "PRODUCTION",
    dayOfWeek: 2,
    isHoliday: false,
    realMinutes: -120,
    approvedMinutes: -60,
  });
  results.push(
    exactResult(
      21,
      "Resultado negativo bloqueado",
      { minutosReales: -120, minutosAprobados: -60 },
      "Ningún resultado final de horas o dinero puede ser negativo.",
      { minutosRealesMinimo: 0, minutosPagablesMinimo: 0, bonoClpMinimo: 0, bloqueado: true },
      compactOvertime(negative),
      negative.realMinutes >= 0 &&
        negative.payableMinutes >= 0 &&
        negative.bonusClp >= 0 &&
        negative.blocked,
      "evaluatePayrollOvertime con minutos negativos"
    )
  );

  const cellEditBase = makeMiniWorkbook();
  const cellEditUpload = rewriteWorkbook(cellEditBase, (book) => {
    book.Sheets.RESUMEN_NOMINA.R6 = { t: "n", v: 45 };
  });
  const cellEditPreview = comparePayrollWorkbooks(cellEditBase, cellEditUpload);
  const cellEdit = cellEditPreview.changes.find(
    (change) => change.sheet === "RESUMEN_NOMINA" && change.cell === "R6"
  );
  results.push(
    exactResult(
      22,
      "Edición y resubida de una celda",
      { hoja: "RESUMEN_NOMINA", celda: "R6", anterior: 0, nuevo: 45 },
      "Una celda reconocida editada debe aparecer en la vista previa con anterior, nuevo y clave estable.",
      { kind: "VALUE", previous: 0, next: 45, consequence: "AJUSTE_EMPRESARIAL", stableKey: true },
      cellEdit ?? null,
      cellEdit?.kind === "VALUE" &&
        cellEdit.previous === 0 &&
        cellEdit.next === 45 &&
        cellEdit.consequence === "AJUSTE_EMPRESARIAL" &&
        cellEdit.stableKey !== null,
      "comparePayrollWorkbooks; cambio RESUMEN_NOMINA!R6"
    )
  );

  const formatBase = makeMiniWorkbook();
  const formatUpload = rewriteWorkbook(formatBase, (book) => {
    const summary = book.Sheets.RESUMEN_NOMINA;
    if (summary.I6) summary.I6.f = "1+1";
    if (summary.B6) {
      summary.B6.s = {
        fill: { patternType: "solid", fgColor: { rgb: "FFFF00" } },
      };
    }
    const columns = summary["!cols"] ?? [];
    columns[0] = { ...(columns[0] ?? {}), wch: 42 };
    summary["!cols"] = columns;
    book.SheetNames = [
      "CONTROL_PENDIENTES",
      "RESUMEN_NOMINA",
      "MATRIZ_DIARIA_SABANA",
      "_GESTORA_TECNICA",
    ];
  });
  const formatPreview = comparePayrollWorkbooks(formatBase, formatUpload);
  const changedFormula = formatPreview.changes.some(
    (change) => change.sheet === "RESUMEN_NOMINA" && change.cell === "I6" && change.kind === "FORMULA"
  );
  const changedColor = formatPreview.changes.some(
    (change) => change.sheet === "RESUMEN_NOMINA" && change.cell === "B6" && change.kind === "FORMAT"
  );
  const changedWidth = formatPreview.changes.some(
    (change) => change.sheet === "RESUMEN_NOMINA" && change.cell === "!cols" && change.kind === "FORMAT"
  );
  const changedOrder = formatPreview.changes.some(
    (change) => change.sheet === "*" && change.cell === "!sheetOrder" && change.kind === "FORMAT"
  );
  const formatChecksPass = changedFormula && changedColor && changedWidth && changedOrder;
  results.push(
    explicitResult(
      23,
      "Edición de fórmula, color, ancho y orden",
      { formula: "I6=1+1", color: "B6 amarillo", anchoColumnaA: 42, ordenHojas: "CONTROL primero" },
      "Fórmula, color, ancho y orden deben conservarse en el archivo exacto; la vista previa debe distinguir lo que no se ejecuta como dato contable.",
      { formulaDetectada: true, colorDetectado: true, anchoDetectado: true, ordenDetectado: true, consecuencia: "CONSERVAR_ARCHIVO_SIN_EJECUTAR" },
      {
        formulaDetectada: changedFormula,
        colorDetectado: changedColor,
        anchoDetectado: changedWidth,
        ordenDetectado: changedOrder,
        cambiosDetectados: formatPreview.changes.map((change) => ({ celda: change.cell, kind: change.kind })),
      },
      formatChecksPass ? "PARCIAL" : "FALLIDO",
      "comparePayrollWorkbooks sobre libro ficticio con cuatro clases de edición",
      formatChecksPass
        ? "La vista previa detectó las cuatro ediciones y las dejó como contenido no contable. La aceptación y descarga byte a byte desde Storage requieren una instancia aislada."
        : "Falló la detección de al menos una edición de fórmula, color, ancho u orden."
    )
  );

  const reappliedWorker = worker({
    employeeId: "33333333-3333-4333-8333-333333333333",
    employeeCode: "SIM-024",
  });
  reappliedWorker.days.set(WORKDAY, day("P", {
    overtime50CandidateMinutes: 121,
    overtime50Minutes: 120,
  }));
  const reappliedBook = readBook(workbookFor([reappliedWorker], {
    workbookBaseVersionId: "44444444-4444-4444-8444-444444444444",
    workbookAdjustments: [
      {
        employeeId: reappliedWorker.employeeId,
        field: "Ajuste HH50 (minutos)",
        value: -30,
        sourceValueAtAcceptance: 120 / 1_440,
        versionNumber: 1,
        decidedAt: "2026-09-06T12:00:00.000Z",
      },
      {
        employeeId: reappliedWorker.employeeId,
        field: "Motivo ajuste HH50",
        value: "Corrección ficticia de RR. HH.",
        sourceValueAtAcceptance: null,
        versionNumber: 1,
        decidedAt: "2026-09-06T12:00:00.000Z",
      },
    ],
  }));
  const reappliedActual = {
    fuenteWorkeraMinutos: Number(cellValue(reappliedBook, "RESUMEN_NOMINA", "AD6")) * 1_440,
    ajusteReaplicado: cellValue(reappliedBook, "RESUMEN_NOMINA", "R6"),
    motivoReaplicado: cellValue(reappliedBook, "RESUMEN_NOMINA", "S6"),
    totalFinalMinutos: Number(cellValue(reappliedBook, "RESUMEN_NOMINA", "I6")) * 1_440,
    descargaExactaDesdeStorage: "no ejecutada",
  };
  const reappliedPureChecksPass =
    reappliedActual.fuenteWorkeraMinutos === 120 &&
    reappliedActual.ajusteReaplicado === -30 &&
    reappliedActual.motivoReaplicado === "Corrección ficticia de RR. HH." &&
    reappliedActual.totalFinalMinutos === 90;
  results.push(
    explicitResult(
      24,
      "Descarga posterior conservando cambios",
      { versionAceptada: "ficticia-v1", fuenteWorkera: 120, ajusteRRHH: -30 },
      "Una descarga futura debe conservar el archivo exacto y reaplicar los cambios empresariales aceptados.",
      { archivoExactoDescargable: true, fuenteWorkera: 120, ajusteReaplicado: -30, totalFinal: 90 },
      reappliedActual,
      reappliedPureChecksPass ? "PARCIAL" : "FALLIDO",
      "buildAttendanceExportWorkbook; RESUMEN_NOMINA!AD6,R6,S6,I6",
      reappliedPureChecksPass
        ? "La reaplicación se ejecutó y fue correcta. La descarga byte a byte desde Storage queda pendiente de una Supabase aislada."
        : "Falló la reaplicación ejecutable; no se oculta como una validación parcial."
    )
  );

  const updatedWorker = worker({
    employeeId: "55555555-5555-4555-8555-555555555555",
    employeeCode: "SIM-025",
  });
  updatedWorker.days.set(SECOND_WORKDAY, day("P", {
    overtime50CandidateMinutes: 120,
    overtime50Minutes: 120,
  }));
  const updatedData = dataFor([updatedWorker], {
    workbookBaseVersionId: "66666666-6666-4666-8666-666666666666",
    workbookAdjustments: [
      {
        employeeId: updatedWorker.employeeId,
        field: "Ajuste HH50 (minutos)",
        value: -30,
        sourceValueAtAcceptance: 60 / 1_440,
        versionNumber: 1,
        decidedAt: "2026-09-06T12:30:00.000Z",
      },
      {
        employeeId: updatedWorker.employeeId,
        field: "Motivo ajuste HH50",
        value: "Ajuste previo ficticio",
        sourceValueAtAcceptance: null,
        versionNumber: 1,
        decidedAt: "2026-09-06T12:30:00.000Z",
      },
    ],
  });
  const updatedBook = readBook(buildAttendanceExportWorkbook(updatedData));
  const updatedPending = allSheetText(updatedBook, "CONTROL_PENDIENTES");
  const updatedConflicts = payrollWorkbookConflicts(updatedData);
  const updatedActual = {
    fuenteAlAceptar: 60,
    ajusteAceptadoOriginal: -30,
    valorFinalDecididoRRHH: 30,
    fuenteActualizada: Number(cellValue(updatedBook, "RESUMEN_NOMINA", "AD6")) * 1_440,
    ajusteVisibleRebasado: cellValue(updatedBook, "RESUMEN_NOMINA", "R6"),
    totalFinalConservado: Number(cellValue(updatedBook, "RESUMEN_NOMINA", "I6")) * 1_440,
    conflictoDetectadoPorMotor: updatedConflicts.some(
      (conflict) => conflict.stableKey === `${updatedWorker.employeeId}|Ajuste HH50 (minutos)`
    ),
    conflictoVisibleEnControl: updatedPending.includes("Conflicto Workera/RR. HH. en HH50"),
    historialPersistido: "no ejecutado",
  };
  const updatedPureChecksPass =
    updatedActual.fuenteActualizada === 120 &&
    updatedActual.ajusteVisibleRebasado === -90 &&
    updatedActual.totalFinalConservado === 30 &&
    updatedActual.conflictoDetectadoPorMotor &&
    updatedActual.conflictoVisibleEnControl;
  results.push(
    explicitResult(
      25,
      "Nueva aprobación después de la subida",
      { fuenteAlAceptar: 60, nuevaAprobacionWorkera: 120, ajusteRRHHPrevio: -30, valorFinalDecididoRRHH: 30 },
      "Una nueva aprobación actualiza GESTORA; la descarga conserva provisionalmente el valor final decidido por RR. HH. recalculando el delta y muestra el conflicto.",
      {
        fuenteActualizada: 120,
        ajusteVisibleRebasado: -90,
        totalFinalConservado: 30,
        conflictoDetectado: true,
        historialPersistido: true,
      },
      updatedActual,
      updatedPureChecksPass ? "PARCIAL" : "FALLIDO",
      "payrollWorkbookConflicts y buildAttendanceExportWorkbook; RESUMEN_NOMINA!AD6/R6/I6 y CONTROL_PENDIENTES",
      updatedPureChecksPass
        ? "El cambio de fuente, el rebase del ajuste, la conservación del valor final y la alerta se ejecutaron. La persistencia del historial exige Supabase/Storage aislados."
        : "Falló una comprobación ejecutable del rebase o del conflicto; no se oculta como una validación parcial."
    )
  );

  const conflictWorker = worker({
    employeeId: "77777777-7777-4777-8777-777777777777",
    employeeCode: "SIM-026",
  });
  conflictWorker.days.set(WORKDAY, day("P", {
    overtime50CandidateMinutes: 60,
    overtime50Minutes: 60,
  }));
  const conflictData = dataFor([conflictWorker], {
    workbookBaseVersionId: "88888888-8888-4888-8888-888888888888",
    workbookAdjustments: [
      {
        employeeId: conflictWorker.employeeId,
        field: "Ajuste HH50 (minutos)",
        value: 30,
        sourceValueAtAcceptance: 0,
        versionNumber: 2,
        decidedAt: "2026-09-06T13:00:00.000Z",
      },
      {
        employeeId: conflictWorker.employeeId,
        field: "Motivo ajuste HH50",
        value: "Decisión RR. HH. ficticia",
        sourceValueAtAcceptance: null,
        versionNumber: 2,
        decidedAt: "2026-09-06T13:00:00.000Z",
      },
    ],
  });
  const conflictWorkbookBytes = buildAttendanceExportWorkbook(conflictData);
  const conflictBook = readBook(conflictWorkbookBytes);
  const conflictText = allSheetText(conflictBook, "CONTROL_PENDIENTES");
  const conflictStableKey = `${conflictWorker.employeeId}|Ajuste HH50 (minutos)`;
  const detectedConflict = payrollWorkbookConflicts(conflictData).find(
    (conflict) => conflict.stableKey === conflictStableKey
  );
  const resolutionCases = detectedConflict
    ? [
        { choice: "KEEP_RRHH" as const, reason: "Mantener decisión ficticia de RR. HH.", expectedAdjustment: -30, expectedFinal: 30 },
        { choice: "ACCEPT_WORKERA" as const, reason: "Aceptar fuente ficticia vigente", expectedAdjustment: 0, expectedFinal: 60 },
        { choice: "THIRD_VALUE" as const, thirdValue: 45, reason: "Definir tercer total ficticio", expectedAdjustment: -15, expectedFinal: 45 },
      ].map((resolutionCase) => {
        const resolvedChanges = applyPayrollWorkbookConflictResolutions(
          conflictWorkbookBytes,
          [],
          [detectedConflict],
          [{
            stableKey: conflictStableKey,
            choice: resolutionCase.choice,
            thirdValue: resolutionCase.thirdValue,
            reason: resolutionCase.reason,
          }]
        );
        const adjustment = resolvedChanges.find(
          (change) => change.stableKey === conflictStableKey && change.kind === "VALUE"
        );
        const reason = resolvedChanges.find(
          (change) => change.stableKey === `${conflictWorker.employeeId}|Motivo ajuste HH50`
        );
        const effectiveAdjustment = typeof adjustment?.next === "number" ? adjustment.next : null;
        return {
          eleccion: resolutionCase.choice,
          tercerValor: resolutionCase.thirdValue ?? null,
          ajusteResultante: effectiveAdjustment,
          totalFinalResultante:
            effectiveAdjustment === null
              ? null
              : Number(detectedConflict.currentWorkeraValue) + effectiveAdjustment,
          resolucionRegistrada: adjustment?.conflictResolution ?? null,
          motivoRegistrado: adjustment?.conflictReason ?? null,
          motivoEmparejado: reason?.next ?? null,
          aprobado:
            effectiveAdjustment === resolutionCase.expectedAdjustment &&
            Number(detectedConflict.currentWorkeraValue) + Number(effectiveAdjustment) === resolutionCase.expectedFinal &&
            adjustment?.conflictResolution === resolutionCase.choice &&
            adjustment?.conflictReason === resolutionCase.reason &&
            reason?.next === resolutionCase.reason,
        };
      })
    : [];
  const conflictActual = {
    conflictoDetectado: detectedConflict !== undefined,
    fuenteAlAceptar: detectedConflict?.sourceAtAcceptance ?? null,
    fuenteWorkeraActual: detectedConflict?.currentWorkeraValue ?? null,
    valorFinalRRHHConservado: detectedConflict?.rrhhFinalValue ?? null,
    ajusteProvisionalRebasado: cellValue(conflictBook, "RESUMEN_NOMINA", "R6"),
    totalFinalProvisional: Number(cellValue(conflictBook, "RESUMEN_NOMINA", "I6")) * 1_440,
    estadoInicial: cellValue(conflictBook, "RESUMEN_NOMINA", "A6"),
    conflictoVisibleEnControl: conflictText.includes("Conflicto Workera/RR. HH. en HH50"),
    resolucionesEjecutadas: resolutionCases,
  };
  const conflictChecksPass =
    conflictActual.conflictoDetectado &&
    conflictActual.fuenteAlAceptar === 0 &&
    conflictActual.fuenteWorkeraActual === 60 &&
    conflictActual.valorFinalRRHHConservado === 30 &&
    conflictActual.ajusteProvisionalRebasado === -30 &&
    conflictActual.totalFinalProvisional === 30 &&
    conflictActual.estadoInicial === "BLOQUEADO" &&
    conflictActual.conflictoVisibleEnControl &&
    resolutionCases.length === 3 &&
    resolutionCases.every((resolution) => resolution.aprobado);
  results.push(exactResult(
    26,
    "Conflicto Workera/RR. HH.",
    { fuenteAlAceptar: 0, ajusteRRHH: 30, nuevoWorkera: 60, trabajador: conflictWorker.employeeId },
    "Si Workera cambia un dato ya intervenido, conserva provisionalmente RR. HH. y ofrece mantener RR. HH., aceptar Workera o un tercer valor.",
    {
      conflictoDetectado: true,
      ajusteProvisionalRebasado: -30,
      valorFinalRRHHConservado: 30,
      estado: "BLOQUEADO",
      resoluciones: [
        { eleccion: "KEEP_RRHH", ajuste: -30, totalFinal: 30 },
        { eleccion: "ACCEPT_WORKERA", ajuste: 0, totalFinal: 60 },
        { eleccion: "THIRD_VALUE", tercerValor: 45, ajuste: -15, totalFinal: 45 },
      ],
    },
    conflictActual,
    conflictChecksPass,
    "payrollWorkbookConflicts, buildAttendanceExportWorkbook y applyPayrollWorkbookConflictResolutions; tres resoluciones ficticias ejecutadas",
    "Se ejecutaron KEEP_RRHH, ACCEPT_WORKERA y THIRD_VALUE. El ajuste visible se rebasa para conservar el total final de RR. HH.; no se confundió el delta antiguo con ese total."
  ));

  const wrongPeriodMessage = rejectionMessage(() =>
    comparePayrollWorkbooks(makeMiniWorkbook(), makeMiniWorkbook({ periodStart: "2026-07-15" }))
  );
  const wrongCompanyMessage = rejectionMessage(() =>
    comparePayrollWorkbooks(
      makeMiniWorkbook({ companyId: COMPANY_A }),
      makeMiniWorkbook({ companyId: COMPANY_B })
    )
  );
  const identity = parsePayrollWorkbook(makeMiniWorkbook()).identity as typeof parsePayrollWorkbook extends (
    bytes: Uint8Array
  ) => { identity: infer T }
    ? T
    : never;
  const companyFieldPresent = Object.prototype.hasOwnProperty.call(identity, "companyId");
  const companyRejected = wrongCompanyMessage !== "NO_RECHAZADO";
  const identityHasCompany = companyFieldPresent;
  const identityCheck = exactResult(
      27,
      "Empresa o período incorrecto",
      { periodoBase: PERIOD.startDate, periodoSubido: "2026-07-15", empresaBase: "empresa-ficticia-a", empresaSubida: "empresa-ficticia-b" },
      "Debe validar y rechazar tanto empresa como período incorrectos.",
      { periodoRechazado: true, empresaValidada: true },
      {
        periodo: { rechazado: wrongPeriodMessage !== "NO_RECHAZADO", mensaje: wrongPeriodMessage },
        empresa: {
          campoIdentidadPresente: identityHasCompany,
          rechazado: companyRejected,
          mensaje: wrongCompanyMessage,
        },
      },
      wrongPeriodMessage !== "NO_RECHAZADO" && identityHasCompany && companyRejected,
      "comparePayrollWorkbooks con Inicio distinto; parsePayrollWorkbook.identity",
      "El resultado exige que tanto el período como la empresa formen parte de la identidad verificada."
    );
  if (identityCheck.estado === "FALLIDO" && wrongPeriodMessage !== "NO_RECHAZADO") {
    identityCheck.estado = "PARCIAL";
    identityCheck.observaciones =
      "El período sí se rechaza, pero la validación de empresa no quedó demostrada completamente.";
  }
  results.push(identityCheck);

  const secureBase = makeMiniWorkbook();
  const archiveForMacro = unzipSync(secureBase);
  archiveForMacro["xl/vbaProject.bin"] = new Uint8Array([0, 1, 2, 3]);
  const macroBytes = zipSync(archiveForMacro);
  const archiveForLink = unzipSync(secureBase);
  archiveForLink["xl/externalLinks/externalLink1.xml"] = strToU8("<externalLink/>");
  const externalLinkBytes = zipSync(archiveForLink);
  const securityActual = {
    corrupto: rejectionMessage(() => parsePayrollWorkbook(new Uint8Array([1, 2, 3, 4]))),
    manipulado: rejectionMessage(() => parsePayrollWorkbook(makeMiniWorkbook({ schema: "ESQUEMA_MANIPULADO" }))),
    macro: rejectionMessage(() => parsePayrollWorkbook(macroBytes)),
    vinculoExterno: rejectionMessage(() => parsePayrollWorkbook(externalLinkBytes)),
  };
  const rejectedSecurityCases = Object.values(securityActual).every(
    (message) => message !== "NO_RECHAZADO"
  );
  results.push(
    exactResult(
      28,
      "Archivo corrupto, manipulado, con macro o vínculo externo",
      { casos: ["firma ZIP inválida", "esquema manipulado", "vbaProject.bin", "xl/externalLinks"] },
      "Los cuatro tipos de archivo no confiable deben rechazarse antes de aplicar cambios.",
      { corruptoRechazado: true, manipuladoRechazado: true, macroRechazada: true, vinculoExternoRechazado: true },
      securityActual,
      rejectedSecurityCases,
      "parsePayrollWorkbook sobre cuatro archivos XLSX ficticios construidos en memoria"
    )
  );

  const duplicateBytes = makeMiniWorkbook();
  const duplicateA = comparePayrollWorkbooks(duplicateBytes, duplicateBytes);
  const duplicateB = comparePayrollWorkbooks(duplicateBytes, duplicateBytes);
  const acceptedVersionId = "66666666-6666-4666-8666-666666666666";
  const concurrentReceipts = new Map<string, string>();
  let concurrentRpcCalls = 0;
  const trustedDependencies = {
    createTrustedClient: () => ({
      storage: {
        from: () => ({
          download: async () => ({
            data: {
              size: duplicateBytes.byteLength,
              arrayBuffer: async () => duplicateBytes.slice().buffer,
            },
            error: null,
          }),
          remove: async () => ({ data: [], error: null }),
        }),
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "get_payroll_workbook_object_identity") {
          const path = String(args.p_storage_path);
          return {
            data: {
              objectId: path.slice(path.lastIndexOf("/") + 1, -5),
              version: "simulated-storage-version-1",
              updatedAt: "2026-09-06T12:00:00.000Z",
            },
            error: null,
          };
        }
        concurrentRpcCalls += 1;
        const key = String(args.p_idempotency_key);
        const existing = concurrentReceipts.get(key);
        if (existing) return { data: existing, error: null };
        concurrentReceipts.set(key, acceptedVersionId);
        return { data: acceptedVersionId, error: null };
      },
    }),
  };
  const acceptanceBase = {
    actorId: "55555555-5555-4555-8555-555555555555",
    companyId: COMPANY_A,
    periodStart: PERIOD.startDate,
    periodEnd: PERIOD.endDate,
    expectedBaseVersionId: null,
    expectedSourceRevision: 41,
    contentSha256: duplicateA.sha256,
    fileSize: duplicateBytes.byteLength,
    generalReason: "Simulación ficticia de idempotencia",
    changes: duplicateA.changes,
  };
  const concurrentAcceptances = await Promise.all([
    acceptTrustedPayrollWorkbook({
      ...acceptanceBase,
      storagePath: `${COMPANY_A}/${PERIOD.startDate}_${PERIOD.endDate}/11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa.xlsx`,
    }, trustedDependencies),
    acceptTrustedPayrollWorkbook({
      ...acceptanceBase,
      storagePath: `${COMPANY_A}/${PERIOD.startDate}_${PERIOD.endDate}/22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb.xlsx`,
    }, trustedDependencies),
  ]);
  const concurrentActual = {
    comparacionesSecuenciales: 2,
    hashCoincide: duplicateA.sha256 === duplicateB.sha256,
    cambiosPrimera: duplicateA.changes.length,
    cambiosSegunda: duplicateB.changes.length,
    aceptacionesConcurrentesAplicacion: concurrentAcceptances.length,
    clavesIdempotenciaUnicas: new Set(concurrentAcceptances.map((item) => item.idempotencyKey)).size,
    versionesLogicasUnicas: new Set(concurrentAcceptances.map((item) => item.versionId)).size,
    recibosFicticiosUnicos: concurrentReceipts.size,
    llamadasRpcFicticias: concurrentRpcCalls,
    concurrenciaPostgresReal: "pendiente de Supabase aislada",
  };
  results.push(
    explicitResult(
      29,
      "Subida duplicada y dos subidas concurrentes",
      { hash: duplicateA.sha256, repeticionesSecuenciales: 2, concurrenciaSolicitada: 2 },
      "La misma subida no duplica ajustes/bonos y dos confirmaciones concurrentes producen una sola versión lógica.",
      { duplicadaIdempotente: true, concurrenciaIdempotente: true, versionesDuplicadas: 0 },
      concurrentActual,
      duplicateA.sha256 === duplicateB.sha256
        && concurrentActual.clavesIdempotenciaUnicas === 1
        && concurrentActual.versionesLogicasUnicas === 1
        && concurrentActual.recibosFicticiosUnicos === 1
        ? "PARCIAL"
        : "FALLIDO",
      "comparePayrollWorkbooks y dos acceptTrustedPayrollWorkbook concurrentes con Storage/RPC ficticios en memoria",
      "La concurrencia de la frontera de aplicación se ejecutó y produjo una clave/versión lógica. La serialización y unicidad PostgreSQL reales exigen una Supabase aislada."
    )
  );

  const closeLifecycle = await simulateCloseAndReopenLifecycle();
  results.push(
    explicitResult(
      30,
      "Cierre, descarga exacta, reapertura con motivo y nueva versión",
      { empresa: "empresa-ficticia", periodo: `${PERIOD.startDate}/${PERIOD.endDate}`, motivoReapertura: "Corrección ficticia" },
      "Solo RR. HH. cierra; guarda snapshot privado inmutable; descarga exacta; reapertura con motivo crea nueva versión sin sobrescribir.",
      { cierreRRHH: true, bytesExactos: true, reaperturaConMotivo: true, versionNueva: true, versionAnteriorIntacta: true },
      closeLifecycle.actual,
      closeLifecycle.executableChecksPassed ? "PARCIAL" : "FALLIDO",
      "closePayrollPeriodWithSnapshot y transitionReportingPeriod ejecutados con cliente/Storage ficticios en memoria",
      closeLifecycle.executableChecksPassed
        ? "El cierre, el orden reserva→subida→verificación, la igualdad de bytes y la reapertura con motivo se ejecutaron. La persistencia transaccional y la nueva versión requieren Supabase/Storage aislados."
        : "Falló al menos una comprobación ejecutable del ciclo de cierre/reapertura ficticio."
    )
  );

  if (results.length !== 30) {
    throw new Error(`El ejecutor produjo ${results.length} simuladores; se esperaban exactamente 30.`);
  }
  for (let index = 0; index < results.length; index += 1) {
    if (results[index].numero !== index + 1) {
      throw new Error(`Secuencia inválida en la posición ${index + 1}.`);
    }
  }
  return results;
}

export function summarizePayrollSimulators(
  results: readonly PayrollSimulatorResult[]
): PayrollSimulatorTotals {
  const count = (status: PayrollSimulatorStatus): number =>
    results.filter((result) => result.estado === status).length;
  const aprobados = count("APROBADO");
  const fallidos = count("FALLIDO");
  const parciales = count("PARCIAL");
  const noEjecutados = count("NO_EJECUTADO");
  return {
    aprobados,
    fallidos,
    parciales,
    noEjecutados,
    porcentajeCumplimiento:
      results.length === 0 ? 0 : Math.round((aprobados / results.length) * 10_000) / 100,
  };
}

function markdownValue(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

export function renderPayrollSimulatorMarkdown(
  results: readonly PayrollSimulatorResult[],
  metadata: {
    commit: string;
    executedAt: string;
    resultsCorrespondExactlyToCommit: boolean;
    workingTreeStatus?: string;
  }
): string {
  const totals = summarizePayrollSimulators(results);
  const unresolved = results.filter((result) => result.estado !== "APROBADO");
  const lines = [
    "# Resultados de los 30 simuladores",
    "",
    `Ejecución: ${metadata.executedAt}`,
    `Commit: ${metadata.commit}`,
    !metadata.resultsCorrespondExactlyToCommit
      ? `Correspondencia exacta con el commit: NO (estado del árbol: ${(metadata.workingTreeStatus ?? "con cambios").replaceAll("\n", "; ")}).`
      : "Correspondencia exacta con el commit: SÍ.",
    "Datos: exclusivamente ficticios. No se usó Supabase compartida ni datos productivos.",
    "",
    "Los 30 simuladores son evidencia separada de los 55 trabajadores ficticios del Excel de muestra y de las pruebas automatizadas.",
    "",
    "| Número del simulador | Situación simulada | Datos de entrada | Regla del prompt que valida | Resultado esperado | Resultado obtenido realmente | Estado | Evidencia | Observaciones o correcciones realizadas |",
    "|---:|---|---|---|---|---|---|---|---|",
    ...results.map(
      (result) =>
        `| ${result.numero} | ${markdownValue(result.situacion)} | ${markdownValue(result.datosEntrada)} | ${markdownValue(result.reglaValidada)} | ${markdownValue(result.resultadoEsperado)} | ${markdownValue(result.resultadoObtenido)} | ${result.estado} | ${markdownValue(result.evidencia)} | ${markdownValue(result.observaciones)} |`
    ),
    "",
    `Totales: ${totals.aprobados} aprobados, ${totals.fallidos} fallidos, ${totals.parciales} parciales, ${totals.noEjecutados} no ejecutados.`,
    `Porcentaje de cumplimiento estricto: ${totals.porcentajeCumplimiento.toFixed(2)}%.`,
    "",
    "## Errores encontrados y correcciones aplicadas",
    "",
    ...unresolved.map(
      (result) =>
        `- Simulador ${result.numero} (${result.estado}): ${result.observaciones}`
    ),
    "- Correcciones de reglas aplicadas por este ejecutor: ninguna; el ejecutor registra resultados y no altera el dominio auditado.",
    "",
    !metadata.resultsCorrespondExactlyToCommit
      ? `Los 30 resultados corresponden al árbol de trabajo ejecutado a las ${metadata.executedAt}; no se atribuyen exactamente al commit ${metadata.commit} mientras las fuentes auditadas tengan cambios.`
      : `Los 30 resultados corresponden exactamente al código del commit ${metadata.commit} al momento ${metadata.executedAt}.`,
    "",
  ];
  return lines.join("\n");
}
