import "server-only";

import { performance } from "node:perf_hooks";
import { strToU8, unzipSync, zipSync } from "fflate";
import * as XLSX from "xlsx-js-style";
import {
  buildAttendanceExportWorkbook,
  calendarDaysBetween,
  isWeekend,
  type AttendanceExportData,
  type AttendanceExportDay,
  type AttendanceExportWorker,
} from "../business-rules/attendance-export";
import {
  comparePayrollWorkbooks,
  inspectXlsxContainer,
  parsePayrollWorkbook,
  PAYROLL_WORKBOOK_LIMITS,
  validatePayrollWorkbookBusinessChanges,
} from "./payroll-workbook-upload";

const SYNTHETIC_COMPANY_ID = "00000000-0000-4000-8000-000000000055";
const SYNTHETIC_PERIOD = {
  type: "PAGO" as const,
  startDate: "2026-07-16",
  endDate: "2026-08-15",
  label: "Remuneraciones agosto de 2026 · datos ficticios de estrés",
};
const VISIBLE_SHEETS = [
  "RESUMEN_NOMINA",
  "CONTROL_PENDIENTES",
  "MATRIZ_DIARIA_SABANA",
] as const;
const TECHNICAL_SHEET = "_GESTORA_TECNICA";
const SUMMARY_HEADERS = [
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
] as const;

export interface PayrollWorkbookStressCase {
  id: string;
  name: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  actual: unknown;
  status: "APROBADO" | "FALLIDO";
  elapsedMs: number;
  heapDeltaBytes: number;
  rssDeltaBytes: number;
  error: string | null;
}

export interface PayrollWorkbookStressReport {
  title: "Estrés de pre-nómina y Excel";
  executedAt: string;
  syntheticDataOnly: true;
  usedSupabase: false;
  usedProduction: false;
  limits: typeof PAYROLL_WORKBOOK_LIMITS;
  cases: PayrollWorkbookStressCase[];
  totals: {
    passed: number;
    failed: number;
    elapsedMs: number;
  };
  memory: {
    rssBeforeBytes: number;
    rssAfterBytes: number;
    heapBeforeBytes: number;
    heapAfterBytes: number;
    maxRssBytes: number;
  };
}

interface SyntheticWorkbookOptions {
  matrixChangedCells?: number;
  businessAdjustments?: boolean;
  hostileFormula?: "WEBSERVICE" | "HYPERLINK" | "DDE";
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function writeWorkbook(book: XLSX.WorkBook): Uint8Array {
  const written = XLSX.write(book, {
    type: "array",
    bookType: "xlsx",
    compression: true,
  }) as Uint8Array | ArrayBuffer;
  return written instanceof Uint8Array ? written : new Uint8Array(written);
}

function appendTechnicalSheet(book: XLSX.WorkBook): void {
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ["Esquema", "GESTORA_PRENOMINA_2026_V2"],
      ["Empresa", SYNTHETIC_COMPANY_ID],
      ["Tipo de período", "PAGO"],
      ["Inicio", SYNTHETIC_PERIOD.startDate],
      ["Fin", SYNTHETIC_PERIOD.endDate],
      ["Mes de remuneración", "2026-08"],
      ["Versión base", "STRESS-FICTICIO"],
    ]),
    TECHNICAL_SHEET
  );
}

function markWorkbookVisibility(book: XLSX.WorkBook): void {
  book.Workbook = {
    Sheets: book.SheetNames.map((name) => ({
      Hidden: name === TECHNICAL_SHEET ? 2 : name.startsWith("_OCULTA_") ? 1 : 0,
    })),
  };
}

/** Libro pequeño y determinista para medir 500 cambios sin depender del estilo. */
function syntheticComparisonWorkbook(options: SyntheticWorkbookOptions = {}): Uint8Array {
  const book = XLSX.utils.book_new();
  const summaryRows: (string | number)[][] = [
    ["Pre-nómina ficticia de estrés"],
    [],
    [],
    [],
    [...SUMMARY_HEADERS],
  ];
  for (let index = 0; index < 55; index += 1) {
    const rowNumber = index + 6;
    const suffix = String(index + 1).padStart(3, "0");
    const businessAdjustments = options.businessAdjustments === true;
    summaryRows.push([
      "REVISAR",
      `FICTICIO-${suffix}`,
      `PERSONA FICTICIA ${suffix}`,
      index % 3 === 0 ? "Producción" : index % 3 === 1 ? "Instalación" : "Administración",
      `CC-FICTICIO-${(index % 3) + 1}`,
      "Lunes a viernes: 08:00 a 17:00",
      20,
      160 / 24,
      120 / 1_440,
      60 / 1_440,
      0,
      0,
      1,
      1_000,
      0,
      "",
      121 / 1_440,
      businessAdjustments ? 1 : 0,
      businessAdjustments ? `Motivo ficticio HH50 ${suffix}` : "",
      61 / 1_440,
      businessAdjustments ? 1 : 0,
      businessAdjustments ? `Motivo ficticio HH100 ${suffix}` : "",
      1_000,
      businessAdjustments ? 1 : 0,
      businessAdjustments ? `Motivo ficticio bono ${suffix}` : "",
      "01/08",
      "",
      `WK-FICTICIO-${suffix}`,
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      120 / 1_440,
      60 / 1_440,
    ]);
    // Las fórmulas no se evalúan en servidor. Los valores cacheados son sólo
    // una representación del archivo y permanecen constantes entre variantes.
    void rowNumber;
  }
  const summary = XLSX.utils.aoa_to_sheet(summaryRows);
  for (let index = 0; index < 55; index += 1) {
    const row = index + 6;
    summary[`I${row}`].f = options.hostileFormula === "WEBSERVICE" && index === 0
      ? 'WEBSERVICE("https://example.invalid/nomina")'
      : `AD${row}+R${row}/1440`;
    summary[`J${row}`].f = options.hostileFormula === "HYPERLINK" && index === 0
      ? 'HYPERLINK("file:///C:/archivo-local","x")'
      : `AE${row}+U${row}/1440`;
    summary[`N${row}`].f = options.hostileFormula === "DDE" && index === 0
      ? "cmd|' /C calc'!A0"
      : `W${row}+X${row}`;
  }

  const changedCells = options.matrixChangedCells ?? 0;
  const matrixRows: string[][] = [];
  for (let row = 0; row < 55; row += 1) {
    const values: string[] = [];
    for (let column = 0; column < 10; column += 1) {
      const flatIndex = row * 10 + column;
      values.push(flatIndex < changedCells ? "F" : "P");
    }
    matrixRows.push(values);
  }

  XLSX.utils.book_append_sheet(book, summary, "RESUMEN_NOMINA");
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([["Sin pendientes ficticios"]]),
    "CONTROL_PENDIENTES"
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet(matrixRows),
    "MATRIZ_DIARIA_SABANA"
  );
  appendTechnicalSheet(book);
  markWorkbookVisibility(book);
  return writeWorkbook(book);
}

function attendanceDay(): AttendanceExportDay {
  return {
    statusCode: "P",
    recordedMinutes: 480,
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
  };
}

function workbookWith55Workers(): Uint8Array {
  const days = calendarDaysBetween(
    SYNTHETIC_PERIOD.startDate,
    SYNTHETIC_PERIOD.endDate
  );
  const scheduledDates = days.filter((date) => !isWeekend(date));
  const workers: AttendanceExportWorker[] = Array.from({ length: 55 }, (_, index) => {
    const suffix = String(index + 1).padStart(3, "0");
    const area = index % 3 === 0
      ? "PRODUCTION"
      : index % 3 === 1
        ? "INSTALLATION"
        : "ADMINISTRATION";
    return {
      employeeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      employeeCode: `WK-FICTICIO-${suffix}`,
      employeeRut: `FICTICIO-${suffix}`,
      workerName: `PERSONA FICTICIA ${suffix}`,
      area,
      costCenter: `CC-FICTICIO-${(index % 3) + 1}`,
      days: new Map(scheduledDates.map((date) => [date, attendanceDay()])),
      hireDate: null,
      currentlyActive: true,
      scheduledWeekdays: new Set([1, 2, 3, 4, 5]),
      scheduleCoveredDates: new Set(days),
      scheduledDates: new Set(scheduledDates),
      exemptDates: new Set<string>(),
      scheduleLabel: "Lunes a viernes: 08:00 a 17:00",
      scheduleConfirmationPending: false,
    };
  });
  const data: AttendanceExportData = {
    period: SYNTHETIC_PERIOD,
    days,
    workers,
    holidays: new Set<string>(),
    reportingPeriodStatus: "CLOSED",
    ruleEngineProblemDates: new Set<string>(),
    companyId: SYNTHETIC_COMPANY_ID,
    workbookBaseVersionId: null,
  };
  return buildAttendanceExportWorkbook(data);
}

function centralDirectoryFixture(input: {
  entries: number;
  declaredUncompressedBytes?: number;
  totalBytes?: number;
}): Uint8Array {
  const requiredBytes = 4 + input.entries * 47;
  const bytes = new Uint8Array(Math.max(requiredBytes, input.totalBytes ?? 0));
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x04034b50, true);
  let remaining = input.declaredUncompressedBytes ?? 0;
  let offset = 4;
  for (let index = 0; index < input.entries; index += 1) {
    view.setUint32(offset, 0x02014b50, true);
    const entriesLeft = input.entries - index;
    const declared = Math.floor(remaining / entriesLeft);
    remaining -= declared;
    view.setUint32(offset + 24, declared, true);
    view.setUint16(offset + 28, 1, true);
    bytes[offset + 46] = 0x61;
    offset += 47;
  }
  return bytes;
}

function dimensionWorkbook(input: {
  rows: number;
  columns: number;
  hiddenExtraSheets?: number;
}): Uint8Array {
  const book = XLSX.utils.book_new();
  const lastCell = XLSX.utils.encode_cell({
    r: input.rows - 1,
    c: input.columns - 1,
  });
  const summary: XLSX.WorkSheet = {
    A1: { t: "s", v: "Ficticio" },
    [lastCell]: { t: "s", v: "Límite ficticio" },
    "!ref": `A1:${lastCell}`,
  };
  XLSX.utils.book_append_sheet(book, summary, "RESUMEN_NOMINA");
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([["Ficticio"]]),
    "CONTROL_PENDIENTES"
  );
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([["Ficticio"]]),
    "MATRIZ_DIARIA_SABANA"
  );
  for (let index = 0; index < (input.hiddenExtraSheets ?? 0); index += 1) {
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([["Ficticio"]]),
      `_OCULTA_${index + 1}`
    );
  }
  appendTechnicalSheet(book);
  markWorkbookVisibility(book);
  return writeWorkbook(book);
}

async function runMeasuredCase(
  definition: Pick<PayrollWorkbookStressCase, "id" | "name" | "input" | "expected">,
  action: () => unknown | Promise<unknown>
): Promise<PayrollWorkbookStressCase> {
  const before = process.memoryUsage();
  const started = performance.now();
  try {
    const actual = await action();
    const after = process.memoryUsage();
    return {
      ...definition,
      actual,
      status: "APROBADO",
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      rssDeltaBytes: after.rss - before.rss,
      error: null,
    };
  } catch (error) {
    const after = process.memoryUsage();
    return {
      ...definition,
      actual: null,
      status: "FALLIDO",
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      rssDeltaBytes: after.rss - before.rss,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runPayrollWorkbookStress(): Promise<PayrollWorkbookStressReport> {
  const processBefore = process.memoryUsage();
  const started = performance.now();
  const cases: PayrollWorkbookStressCase[] = [];

  cases.push(await runMeasuredCase({
    id: "volume-55-workers",
    name: "Generación, lectura y estructura con 55 trabajadores",
    input: { workers: 55, calendarDays: 31, data: "fictitious" },
    expected: { visibleSheets: 3, workers: 55, maxBytes: PAYROLL_WORKBOOK_LIMITS.maxBytes },
  }, () => {
    const bytes = workbookWith55Workers();
    const parsed = parsePayrollWorkbook(bytes);
    const visibleSheets = parsed.book.SheetNames.filter((_, index) =>
      (parsed.book.Workbook?.Sheets?.[index]?.Hidden ?? 0) === 0
    );
    const summaryRange = XLSX.utils.decode_range(parsed.book.Sheets.RESUMEN_NOMINA["!ref"] ?? "A1:A1");
    const workerRows = summaryRange.e.r - 5;
    ensure(workerRows === 55, `Se leyeron ${workerRows} trabajadores, no 55.`);
    ensure(
      JSON.stringify(visibleSheets) === JSON.stringify(VISIBLE_SHEETS),
      `Hojas visibles inesperadas: ${visibleSheets.join(", ")}.`
    );
    ensure(bytes.length <= PAYROLL_WORKBOOK_LIMITS.maxBytes, "El libro de 55 personas excedió 15 MB.");
    return {
      bytes: bytes.length,
      workersRead: workerRows,
      sheets: parsed.book.SheetNames.length,
      visibleSheets,
      sha256: parsed.sha256,
    };
  }));

  cases.push(await runMeasuredCase({
    id: "exactly-500-changes",
    name: "Comparación de exactamente 500 cambios",
    input: { workers: 55, changedCells: 500, repetitions: 1 },
    expected: { detectedChanges: 500, deterministicHash: true },
  }, () => {
    const base = syntheticComparisonWorkbook();
    const upload = syntheticComparisonWorkbook({ matrixChangedCells: 500 });
    const preview = comparePayrollWorkbooks(base, upload);
    ensure(preview.changes.length === 500, `Se detectaron ${preview.changes.length} cambios, no 500.`);
    ensure(preview.changes.every((change) => change.kind === "VALUE"), "Los 500 cambios no fueron todos de valor.");
    return {
      baseBytes: base.length,
      uploadedBytes: upload.length,
      detectedChanges: preview.changes.length,
      uploadedSha256: preview.sha256,
    };
  }));

  cases.push(await runMeasuredCase({
    id: "above-500-change-boundary",
    name: "Detección inequívoca del cambio 501",
    input: { workers: 55, changedCells: 501 },
    expected: { detectedChanges: 501, exceedsReviewLimit: true },
  }, () => {
    const preview = comparePayrollWorkbooks(
      syntheticComparisonWorkbook(),
      syntheticComparisonWorkbook({ matrixChangedCells: 501 })
    );
    ensure(preview.changes.length === 501, `Se detectaron ${preview.changes.length} cambios, no 501.`);
    return {
      detectedChanges: preview.changes.length,
      exceedsReviewLimit: preview.changes.length > 500,
    };
  }));

  cases.push(await runMeasuredCase({
    id: "business-adjustments-55-workers",
    name: "Validación masiva de ajustes con motivo para 55 trabajadores",
    input: { workers: 55, editableFieldsPerWorker: 6, expectedChanges: 330 },
    expected: { businessChanges: 330, validationIssues: 0 },
  }, () => {
    const base = syntheticComparisonWorkbook();
    const upload = syntheticComparisonWorkbook({ businessAdjustments: true });
    const preview = comparePayrollWorkbooks(base, upload);
    const businessChanges = preview.changes.filter(
      (change) => change.consequence === "AJUSTE_EMPRESARIAL"
    );
    const issues = validatePayrollWorkbookBusinessChanges(base, preview.changes);
    ensure(businessChanges.length === 330, `Se detectaron ${businessChanges.length} ajustes empresariales, no 330.`);
    ensure(issues.length === 0, `La validación produjo incidencias: ${issues.join(" | ")}`);
    return {
      totalChanges: preview.changes.length,
      businessChanges: businessChanges.length,
      validationIssues: issues,
    };
  }));

  cases.push(await runMeasuredCase({
    id: "hostile-formulas-rejected",
    name: "Fórmulas externas o potencialmente ejecutables rechazadas",
    input: { formulas: ["WEBSERVICE", "HYPERLINK file", "DDE cmd"] },
    expected: { rejected: 3, accepted: 0 },
  }, () => {
    const messages = (["WEBSERVICE", "HYPERLINK", "DDE"] as const).map((hostileFormula) =>
      errorMessage(() => parsePayrollWorkbook(syntheticComparisonWorkbook({ hostileFormula })))
    );
    ensure(messages.every((message) => message !== null), "Una fórmula hostil fue aceptada.");
    return { rejected: messages.length, messages };
  }));

  cases.push(await runMeasuredCase({
    id: "malicious-and-corrupt-files",
    name: "Rechazo de archivos corruptos, macros, vínculos y rutas inseguras",
    input: { variants: 6 },
    expected: { rejected: 6, accepted: 0 },
  }, () => {
    const valid = syntheticComparisonWorkbook();
    const withMacro = unzipSync(valid);
    withMacro["xl/vbaProject.bin"] = strToU8("macro ficticia");
    const withExternalLink = unzipSync(valid);
    withExternalLink["xl/externalLinks/externalLink1.xml"] = strToU8("<externalLink/>");
    const withExternalRelationship = unzipSync(valid);
    withExternalRelationship["custom/_rels/hostile.rels"] = strToU8(
      '<Relationships><Relationship Target="https://example.invalid/datos.xlsx" TargetMode="External"/></Relationships>'
    );
    const messages = {
      corruptSignature: errorMessage(() => parsePayrollWorkbook(new Uint8Array([1, 2, 3, 4]))),
      truncatedZip: errorMessage(() => parsePayrollWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))),
      zipTraversal: errorMessage(() => inspectXlsxContainer(zipSync({ "../escape.txt": strToU8("ficticio") }))),
      macro: errorMessage(() => parsePayrollWorkbook(zipSync(withMacro))),
      externalLink: errorMessage(() => parsePayrollWorkbook(zipSync(withExternalLink))),
      externalRelationship: errorMessage(() => parsePayrollWorkbook(zipSync(withExternalRelationship))),
    };
    const rejected = Object.values(messages).filter((message) => message !== null).length;
    ensure(rejected === 6, `Sólo se rechazaron ${rejected} de 6 variantes hostiles.`);
    return { rejected, messages };
  }));

  cases.push(await runMeasuredCase({
    id: "zip-container-boundaries",
    name: "Límites exactos y excedidos del contenedor ZIP",
    input: {
      byteBoundary: PAYROLL_WORKBOOK_LIMITS.maxBytes,
      entryBoundary: PAYROLL_WORKBOOK_LIMITS.maxEntries,
      uncompressedBoundary: PAYROLL_WORKBOOK_LIMITS.maxUncompressedBytes,
    },
    expected: { exactLimitsAccepted: 3, exceededLimitsRejected: 3 },
  }, () => {
    const exactBytes = centralDirectoryFixture({
      entries: 1,
      totalBytes: PAYROLL_WORKBOOK_LIMITS.maxBytes,
    });
    const exactEntries = centralDirectoryFixture({
      entries: PAYROLL_WORKBOOK_LIMITS.maxEntries,
    });
    const exactUncompressed = centralDirectoryFixture({
      entries: 1,
      declaredUncompressedBytes: PAYROLL_WORKBOOK_LIMITS.maxUncompressedBytes,
    });
    inspectXlsxContainer(exactBytes);
    inspectXlsxContainer(exactEntries);
    inspectXlsxContainer(exactUncompressed);

    const overBytes = centralDirectoryFixture({
      entries: 1,
      totalBytes: PAYROLL_WORKBOOK_LIMITS.maxBytes + 1,
    });
    const overEntries = centralDirectoryFixture({
      entries: PAYROLL_WORKBOOK_LIMITS.maxEntries + 1,
    });
    const overUncompressed = centralDirectoryFixture({
      entries: 1,
      declaredUncompressedBytes: PAYROLL_WORKBOOK_LIMITS.maxUncompressedBytes + 1,
    });
    const rejections = [
      errorMessage(() => inspectXlsxContainer(overBytes)),
      errorMessage(() => inspectXlsxContainer(overEntries)),
      errorMessage(() => inspectXlsxContainer(overUncompressed)),
    ];
    ensure(rejections.every((message) => message !== null), "Un contenedor sobre el límite fue aceptado.");
    return {
      exactAccepted: 3,
      overLimitRejected: rejections.length,
      rejectionMessages: rejections,
    };
  }));

  cases.push(await runMeasuredCase({
    id: "sheet-row-column-boundaries",
    name: "Esquema exacto de hojas y límites de filas/columnas",
    input: {
      allowedSheets: 4,
      maxRows: PAYROLL_WORKBOOK_LIMITS.maxRows,
      maxColumns: PAYROLL_WORKBOOK_LIMITS.maxColumns,
    },
    expected: { exactLimitsAccepted: 3, exceededLimitsRejected: 3 },
  }, () => {
    parsePayrollWorkbook(dimensionWorkbook({ rows: 1, columns: 1 }));
    parsePayrollWorkbook(dimensionWorkbook({ rows: PAYROLL_WORKBOOK_LIMITS.maxRows, columns: 1 }));
    parsePayrollWorkbook(dimensionWorkbook({ rows: 1, columns: PAYROLL_WORKBOOK_LIMITS.maxColumns }));
    const rejections = [
      errorMessage(() => parsePayrollWorkbook(dimensionWorkbook({ rows: 1, columns: 1, hiddenExtraSheets: 1 }))),
      errorMessage(() => parsePayrollWorkbook(dimensionWorkbook({ rows: PAYROLL_WORKBOOK_LIMITS.maxRows + 1, columns: 1 }))),
      errorMessage(() => parsePayrollWorkbook(dimensionWorkbook({ rows: 1, columns: PAYROLL_WORKBOOK_LIMITS.maxColumns + 1 }))),
    ];
    ensure(rejections.every((message) => message !== null), "Un libro sobre límites de hoja/fila/columna fue aceptado.");
    return { exactAccepted: 3, overLimitRejected: 3, rejectionMessages: rejections };
  }));

  cases.push(await runMeasuredCase({
    id: "cell-budget-boundary",
    name: "Presupuesto cercano y excedido de celdas",
    input: {
      under: { rows: 4_999, columns: 40 },
      over: { rows: 5_000, columns: 40 },
      maxCells: PAYROLL_WORKBOOK_LIMITS.maxCells,
    },
    expected: { underAccepted: true, overRejected: true },
  }, () => {
    const under = dimensionWorkbook({ rows: 4_999, columns: 40 });
    parsePayrollWorkbook(under);
    const overMessage = errorMessage(() =>
      parsePayrollWorkbook(dimensionWorkbook({ rows: 5_000, columns: 40 }))
    );
    ensure(overMessage !== null, "El libro que excede el presupuesto total de celdas fue aceptado.");
    return {
      underWorkbookBytes: under.length,
      underEstimatedCells: 4_999 * 40 + 16,
      overEstimatedCells: 5_000 * 40 + 16,
      overRejection: overMessage,
    };
  }));

  cases.push(await runMeasuredCase({
    id: "repeated-comparison",
    name: "Repetición determinista de parseo y comparación",
    input: { repetitions: 25, workers: 55, changesPerRun: 500 },
    expected: { stableRuns: 25, changesEveryRun: 500, maxElapsedMs: 60_000 },
  }, () => {
    const base = syntheticComparisonWorkbook();
    const upload = syntheticComparisonWorkbook({ matrixChangedCells: 500 });
    let expectedHash: string | null = null;
    for (let iteration = 0; iteration < 25; iteration += 1) {
      const preview = comparePayrollWorkbooks(base, upload);
      ensure(preview.changes.length === 500, `Iteración ${iteration + 1}: cambios=${preview.changes.length}.`);
      expectedHash ??= preview.sha256;
      ensure(preview.sha256 === expectedHash, `Iteración ${iteration + 1}: hash no determinista.`);
    }
    return { stableRuns: 25, changesEveryRun: 500, sha256: expectedHash };
  }));

  const processAfter = process.memoryUsage();
  const passed = cases.filter((item) => item.status === "APROBADO").length;
  const failed = cases.length - passed;
  return {
    title: "Estrés de pre-nómina y Excel",
    executedAt: new Date().toISOString(),
    syntheticDataOnly: true,
    usedSupabase: false,
    usedProduction: false,
    limits: PAYROLL_WORKBOOK_LIMITS,
    cases,
    totals: {
      passed,
      failed,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    },
    memory: {
      rssBeforeBytes: processBefore.rss,
      rssAfterBytes: processAfter.rss,
      heapBeforeBytes: processBefore.heapUsed,
      heapAfterBytes: processAfter.heapUsed,
      maxRssBytes: process.resourceUsage().maxRSS * 1_024,
    },
  };
}
