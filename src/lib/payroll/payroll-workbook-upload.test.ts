import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import * as XLSX from "xlsx-js-style";
import { canonicalRosterSha256 } from "../employees/arcotex-pilot-roster";
import { applyPayrollWorkbookConflictResolutions, comparePayrollWorkbooks, expandPayrollWorkbookBusinessChanges, inspectXlsxContainer, parsePayrollWorkbook, validatePayrollWorkbookBusinessChanges } from "./payroll-workbook-upload";

const VISIBLE_SHEETS = ["RESUMEN_NOMINA", "CONTROL_PENDIENTES", "MATRIZ_DIARIA_SABANA"] as const;
type VisibleSheet = typeof VISIBLE_SHEETS[number];

interface WorkbookOptions {
  companyId?: string;
  payableCachedValue?: number;
  payableFormula?: string;
  ordinaryHours?: number;
  adjustmentHH50?: number;
  adjustmentReasonHH50?: string;
  automaticHH50Minutes?: number;
  adjustmentHeader?: string;
  employeeId?: string;
  secondEmployeeId?: string;
  observation?: string;
  visibleOrder?: readonly VisibleSheet[];
  technicalVisibility?: 0 | 1 | 2;
  addVisibleSheet?: boolean;
  addHiddenSheet?: boolean;
  firstColumnWidth?: number;
  dailyCode?: string;
  secondDateDailyCode?: string;
  matrixWorkerCode?: string;
  reorderSummaryRows?: boolean;
  reorderMatrixRows?: boolean;
  reorderMatrixDates?: boolean;
  matrixDates?: readonly string[];
  definedNameRef?: string;
  rosterCount?: number | string;
  rosterSha256?: string;
  workerCode?: string;
}

function workbook(options: WorkbookOptions = {}): Uint8Array {
  const book = XLSX.utils.book_new();
  const headers = ["Estado", "RUT", "Nombre completo", "Área", "Centro de costo", "Jornada", "Días con presencia", "Horas ordinarias registradas", "HH50 pagables", "HH100 pagables", "Atrasos descontables", "Salidas anticipadas descontables", "Días con bono", "Bono total", "Pendientes", "Observaciones", "HH50 reales", "Ajuste HH50 (minutos)", "Motivo ajuste HH50", "HH100 reales", "Ajuste HH100 (minutos)", "Motivo ajuste HH100", "Bono HE automático", "Ajuste bono (CLP)", "Motivo ajuste bono", "Fechas de bono", "Fechas pendientes", "Código Workera", "Identificador técnico", "HH50 aprobado automático", "HH100 aprobado automático"];
  headers[17] = options.adjustmentHeader ?? headers[17];
  const firstEmployeeId = options.employeeId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const firstWorkerCode = options.workerCode ?? "WK-1";
  const workerRow = (employeeId: string, code: string, name: string, first: boolean) =>
    ["REVISAR", first ? "11111111-1" : "22222222-2", name, "Producción", "CC", "08:00-17:00", 1, options.ordinaryHours ?? 8 / 24, options.payableCachedValue ?? 0, 0, 0, 0, 0, 0, 0, options.observation ?? "", 0, first ? options.adjustmentHH50 ?? 0 : 0, first ? options.adjustmentReasonHH50 ?? "" : "", 0, 0, "", 0, 0, "", "", "", code, employeeId, (first ? options.automaticHH50Minutes ?? 0 : 0) / 1_440, 0];
  const summaryWorkers = [
    workerRow(firstEmployeeId, firstWorkerCode, "Persona uno", true),
    ...(options.secondEmployeeId ? [workerRow(options.secondEmployeeId, "WK-2", "Persona dos", false)] : []),
  ];
  if (options.reorderSummaryRows) summaryWorkers.reverse();
  const rows: unknown[][] = [
    ["Título"], [], [], [],
    headers,
    ...summaryWorkers,
  ];
  const summary = XLSX.utils.aoa_to_sheet(rows);
  for (let row = 5; row < 5 + summaryWorkers.length; row += 1) {
    const ref = XLSX.utils.encode_cell({ r: row, c: 8 });
    summary[ref].f = row === 5 && !options.reorderSummaryRows
      ? options.payableFormula ?? `AD${row + 1}+R${row + 1}/1440`
      : `AD${row + 1}+R${row + 1}/1440`;
  }
  summary["!cols"] = [{ wch: options.firstColumnWidth ?? 18 }];

  const semanticDates = [...(options.matrixDates ?? ["2026-07-16"])];
  const displayedDates = options.reorderMatrixDates ? [...semanticDates].reverse() : semanticDates;
  const matrixWorkers = [
    { rut: "11111111-1", code: options.matrixWorkerCode ?? firstWorkerCode, name: "Persona uno" },
    ...(options.secondEmployeeId ? [{ rut: "22222222-2", code: "WK-2", name: "Persona dos" }] : []),
  ];
  if (options.reorderMatrixRows) matrixWorkers.reverse();
  const dailyValue = (code: string, date: string) => {
    if (code !== "WK-1") return "P";
    if (date === semanticDates[0]) return options.dailyCode ?? "P";
    if (date === semanticDates[1]) return options.secondDateDailyCode ?? "P";
    return "P";
  };
  const matrixRows: unknown[][] = [
    ["Matriz"], [], [], [],
    ["RUT", "Código Workera", "Nombre completo", "Jornada", "Centro de costo", ...displayedDates],
    ...matrixWorkers.map((employee) => [employee.rut, employee.code, employee.name, "08:00-17:00", "CC", ...displayedDates.map((date) => dailyValue(employee.code, date))]),
  ];

  const sheets: Record<VisibleSheet, XLSX.WorkSheet> = {
    RESUMEN_NOMINA: summary,
    CONTROL_PENDIENTES: XLSX.utils.aoa_to_sheet([["Pendientes"]]),
    MATRIZ_DIARIA_SABANA: XLSX.utils.aoa_to_sheet(matrixRows),
  };
  for (const name of options.visibleOrder ?? VISIBLE_SHEETS) XLSX.utils.book_append_sheet(book, sheets[name], name);
  if (options.addVisibleSheet) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["No permitida"]]), "HOJA_EXTRA");
  if (options.addHiddenSheet) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["No permitida"]]), "HOJA_OCULTA");
  const technicalRows: unknown[][] = [["Esquema", "GESTORA_PRENOMINA_2026_V2"], ["Empresa", options.companyId ?? "11111111-1111-4111-8111-111111111111"], ["Tipo de período", "PAGO"], ["Inicio", "2026-07-16"], ["Fin", "2026-08-15"], ["Mes de remuneración", "2026-08"], ["Versión base", "2"]];
  if (options.rosterCount !== undefined) technicalRows.push(["Cantidad padrón autorizado", options.rosterCount]);
  if (options.rosterSha256 !== undefined) technicalRows.push(["Huella padrón autorizado", options.rosterSha256]);
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(technicalRows), "_GESTORA_TECNICA");
  book.Workbook = {
    Sheets: book.SheetNames.map((name) => ({ Hidden: name === "_GESTORA_TECNICA" ? options.technicalVisibility ?? 2 : name === "HOJA_OCULTA" ? 1 : 0 })),
    Names: options.definedNameRef ? [{ Name: "DatoExterno", Ref: options.definedNameRef }] : undefined,
  };
  const written = XLSX.write(book, { type: "array", bookType: "xlsx", compression: true }) as Uint8Array | ArrayBuffer;
  return written instanceof Uint8Array ? written : new Uint8Array(written);
}

test("subida XLSX: valida identidad, hash y ajuste por clave estable permitida", () => {
  const preview = comparePayrollWorkbooks(workbook(), workbook({ adjustmentHH50: 30 }));
  assert.match(preview.sha256, /^[a-f0-9]{64}$/);
  assert.equal(preview.identity.companyId, "11111111-1111-4111-8111-111111111111");
  assert.equal(preview.identity.payrollMonth, "2026-08");
  const change = preview.changes.find((item) => item.cell === "R6");
  assert.equal(change?.stableKey, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|Ajuste HH50 (minutos)");
  assert.equal(change?.consequence, "AJUSTE_EMPRESARIAL");
  assert.equal(change?.sourceValueAtComparison, 0);
});

test("subida XLSX: la identidad técnica conserva y enlaza la atestación del padrón", () => {
  const rosterSha256 = canonicalRosterSha256(["WK-1"]);
  const parsed = parsePayrollWorkbook(workbook({ rosterCount: 1, rosterSha256 }));
  assert.equal(parsed.identity.rosterCount, 1);
  assert.equal(parsed.identity.rosterSha256, rosterSha256);

  assert.throws(
    () => comparePayrollWorkbooks(
      workbook({ rosterCount: 1, rosterSha256 }),
      workbook({ workerCode: "WK-OTRO", rosterCount: 1, rosterSha256: canonicalRosterSha256(["WK-OTRO"]) }),
    ),
    /identidad técnica.*padrón/i,
  );
});

test("subida XLSX: rechaza una atestación de padrón incompleta o inválida", () => {
  assert.throws(() => parsePayrollWorkbook(workbook({ rosterCount: 45 })), /atestación.*incompleta/i);
  assert.throws(() => parsePayrollWorkbook(workbook({ rosterSha256: "a".repeat(64) })), /atestación.*incompleta/i);
  assert.throws(
    () => parsePayrollWorkbook(workbook({ rosterCount: "45.5", rosterSha256: "a".repeat(64) })),
    /cantidad.*no es válida/i,
  );
  assert.throws(
    () => parsePayrollWorkbook(workbook({ rosterCount: 45, rosterSha256: "NO-ES-UNA-HUELLA" })),
    /huella.*no es válida/i,
  );
  assert.throws(
    () => parsePayrollWorkbook(workbook({ rosterCount: 45, rosterSha256: canonicalRosterSha256(["WK-1"]) })),
    /cantidad declarada.*no coincide/i,
  );
  assert.throws(
    () => parsePayrollWorkbook(workbook({ rosterCount: 1, rosterSha256: "f".repeat(64) })),
    /huella declarada.*no coincide/i,
  );
});

test("subida XLSX: limita los ajustes empresariales a columnas explícitas de ajuste y motivo", () => {
  const preview = comparePayrollWorkbooks(workbook(), workbook({ ordinaryHours: 9 / 24, observation: "texto libre" }));
  for (const cell of ["H6", "P6"]) {
    const change = preview.changes.find((item) => item.cell === cell);
    assert.equal(change?.stableKey, null);
    assert.equal(change?.consequence, "CONSERVAR_ARCHIVO_SIN_EJECUTAR");
  }
});

test("subida XLSX: rechaza reemplazar la identidad técnica del trabajador", () => {
  assert.throws(
    () => comparePayrollWorkbooks(
      workbook(),
      workbook({ adjustmentHH50: 45, adjustmentHeader: "Encabezado manipulado", employeeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" })
    ),
    /identidad de trabajadores cambió/
  );
});

test("subida XLSX: admite reordenar trabajadores del resumen y atribuye el ajuste al UUID correcto", () => {
  const employeeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const employeeB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const base = workbook({ employeeId: employeeA, secondEmployeeId: employeeB });
  const preview = comparePayrollWorkbooks(base, workbook({
    employeeId: employeeA,
    secondEmployeeId: employeeB,
    reorderSummaryRows: true,
    adjustmentHH50: 30,
  }));
  const businessChanges = preview.changes.filter((change) => change.consequence === "AJUSTE_EMPRESARIAL");

  assert.equal(businessChanges.length, 1);
  assert.equal(businessChanges[0].stableKey, `${employeeA}|Ajuste HH50 (minutos)`);
  assert.equal(businessChanges[0].cell, "R6");
  assert.equal(businessChanges[0].previous, 0);
  assert.equal(businessChanges[0].next, 30);
  assert.ok(preview.changes.some((change) => change.sheet === "RESUMEN_NOMINA" && change.cell === "!rowOrder"));
});

test("subida XLSX: rechaza UUID duplicado, faltante o sustituido aunque el orden sea editable", () => {
  const employeeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const employeeB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const base = workbook({ employeeId: employeeA, secondEmployeeId: employeeB });
  assert.throws(
    () => comparePayrollWorkbooks(base, workbook({ employeeId: employeeA, secondEmployeeId: employeeA })),
    /duplicado/
  );
  assert.throws(
    () => comparePayrollWorkbooks(base, workbook({ employeeId: "", secondEmployeeId: employeeB })),
    /falta o no es un UUID válido/
  );
  assert.throws(
    () => comparePayrollWorkbooks(base, workbook({ employeeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", secondEmployeeId: employeeB })),
    /identidad de trabajadores cambió/
  );
});

test("subida XLSX: rechaza cambiar el Código Workera ligado a un UUID", () => {
  assert.throws(
    () => comparePayrollWorkbooks(workbook(), workbook({ matrixWorkerCode: "WK-ALTERADO" })),
    /MATRIZ_DIARIA_SABANA.*Código Workera|Código Workera/
  );

  const base = workbook({
    employeeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    secondEmployeeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  const uploadedBook = XLSX.read(base, { type: "array", cellFormula: true, cellStyles: true });
  uploadedBook.Sheets.RESUMEN_NOMINA.AB6.v = "WK-2";
  uploadedBook.Sheets.RESUMEN_NOMINA.AB7.v = "WK-1";
  const swappedOutput = XLSX.write(uploadedBook, {
    type: "array",
    bookType: "xlsx",
    compression: true,
  }) as Uint8Array | ArrayBuffer;
  const swapped = swappedOutput instanceof Uint8Array
    ? swappedOutput
    : new Uint8Array(swappedOutput);

  assert.throws(
    () => comparePayrollWorkbooks(base, swapped),
    /Código Workera del trabajador .* cambió/
  );
});

test("subida XLSX: admite reordenar la sábana por trabajador sin cruzar códigos diarios", () => {
  const employeeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const employeeB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const base = workbook({ employeeId: employeeA, secondEmployeeId: employeeB });
  const preview = comparePayrollWorkbooks(base, workbook({
    employeeId: employeeA,
    secondEmployeeId: employeeB,
    reorderMatrixRows: true,
    dailyCode: "F-J",
  }));
  const businessChanges = preview.changes.filter((change) => change.consequence === "AJUSTE_EMPRESARIAL");

  assert.equal(businessChanges.length, 1);
  assert.equal(businessChanges[0].stableKey, `${employeeA}|2026-07-16|Código asistencia`);
  assert.equal(businessChanges[0].cell, "F6");
  assert.equal(businessChanges[0].previous, "P");
  assert.equal(businessChanges[0].next, "F-J");
});

test("subida XLSX: admite reordenar columnas de fechas y mantiene la fecha en la clave estable", () => {
  const employeeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const dates = ["2026-07-16", "2026-07-17"];
  const base = workbook({ employeeId: employeeA, matrixDates: dates });
  const preview = comparePayrollWorkbooks(base, workbook({
    employeeId: employeeA,
    matrixDates: dates,
    reorderMatrixDates: true,
    secondDateDailyCode: "L-M",
  }));
  const businessChanges = preview.changes.filter((change) => change.consequence === "AJUSTE_EMPRESARIAL");

  assert.equal(businessChanges.length, 1);
  assert.equal(businessChanges[0].stableKey, `${employeeA}|2026-07-17|Código asistencia`);
  assert.equal(businessChanges[0].cell, "G6");
  assert.equal(businessChanges[0].previous, "P");
  assert.equal(businessChanges[0].next, "L-M");
  assert.ok(preview.changes.some((change) => change.sheet === "MATRIZ_DIARIA_SABANA" && change.cell === "!columnOrder"));
});

test("subida XLSX: un reordenamiento puro solo produce evidencia estructural no ejecutable", () => {
  const options = {
    employeeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    secondEmployeeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    matrixDates: ["2026-07-16", "2026-07-17"],
  } as const;
  const preview = comparePayrollWorkbooks(workbook(options), workbook({
    ...options,
    reorderSummaryRows: true,
    reorderMatrixRows: true,
    reorderMatrixDates: true,
  }));

  assert.equal(preview.changes.length, 3);
  assert.ok(preview.changes.every((change) => change.kind === "FORMAT" && change.cell.startsWith("!") && change.consequence === "CONSERVAR_ARCHIVO_SIN_EJECUTAR"));
});

test("subida XLSX: fórmula se conserva en archivo pero no se ejecuta como dato", () => {
  const preview = comparePayrollWorkbooks(workbook(), workbook({ payableFormula: "1+1" }));
  const change = preview.changes.find((item) => item.kind === "FORMULA");
  assert.equal(change?.consequence, "CONSERVAR_ARCHIVO_SIN_EJECUTAR");
});

test("subida XLSX: rechaza fórmulas externas o potencialmente ejecutables", () => {
  for (const formula of [
    'WEBSERVICE("https://example.invalid/nomina")',
    'HYPERLINK("file:///C:/archivo-local","abrir")',
    'IMAGE(CHAR(104)&CHAR(116)&CHAR(116)&CHAR(112)&CHAR(115)&CHAR(58)&CHAR(47)&CHAR(47)&A1)',
    '_xlfn.IMAGE(CHAR(104)&CHAR(116)&CHAR(116)&CHAR(112)&CHAR(115)&CHAR(58)&CHAR(47)&CHAR(47)&A1)',
    "cmd|' /C calc'!A0",
    "notepad|'archivo.txt'!A1",
  ]) {
    assert.throws(
      () => parsePayrollWorkbook(workbook({ payableFormula: formula })),
      /fórmula externa o potencialmente ejecutable/
    );
  }
});

test("subida XLSX: ignora valores cacheados distintos cuando la fórmula es idéntica", () => {
  const preview = comparePayrollWorkbooks(workbook({ payableCachedValue: 0 }), workbook({ payableCachedValue: 1 / 24 }));
  assert.equal(preview.changes.some((item) => item.cell === "I6"), false);
});

test("subida XLSX: admite reordenar las tres hojas visibles y lo reporta sin ejecutarlo", () => {
  const reordered = workbook({ visibleOrder: ["MATRIZ_DIARIA_SABANA", "RESUMEN_NOMINA", "CONTROL_PENDIENTES"] });
  assert.doesNotThrow(() => parsePayrollWorkbook(reordered));
  const change = comparePayrollWorkbooks(workbook(), reordered).changes.find((item) => item.cell === "!sheetOrder");
  assert.equal(change?.kind, "FORMAT");
  assert.equal(change?.consequence, "CONSERVAR_ARCHIVO_SIN_EJECUTAR");
});

test("subida XLSX: detecta anchos de columna como cambio estructural no ejecutable", () => {
  const preview = comparePayrollWorkbooks(workbook(), workbook({ firstColumnWidth: 24 }));
  const change = preview.changes.find((item) => item.sheet === "RESUMEN_NOMINA" && item.cell === "!cols");
  assert.equal(change?.kind, "FORMAT");
  assert.equal(change?.consequence, "CONSERVAR_ARCHIVO_SIN_EJECUTAR");
});

test("subida XLSX: exige exactamente las tres hojas visibles oficiales", () => {
  assert.throws(
    () => parsePayrollWorkbook(workbook({ addVisibleSheet: true })),
    /solo admite las tres hojas oficiales y la hoja técnica identificada/,
  );
  assert.throws(() => parsePayrollWorkbook(workbook({ addHiddenSheet: true })), /solo admite las tres hojas oficiales/);
});

test("subida XLSX: exige que la hoja técnica permanezca veryHidden", () => {
  assert.throws(() => parsePayrollWorkbook(workbook({ technicalVisibility: 0 })), /hoja técnica debe permanecer en estado veryHidden/);
});

test("subida XLSX: exige Empresa como UUID técnico y bloquea otra empresa", () => {
  assert.throws(() => parsePayrollWorkbook(workbook({ companyId: "empresa-invalida" })), /empresa técnica no contiene un UUID válido/);
  assert.throws(
    () => comparePayrollWorkbooks(workbook(), workbook({ companyId: "22222222-2222-4222-8222-222222222222" })),
    /identidad técnica.*no coincide/
  );
});

test("subida XLSX: repetición idéntica es idempotente", () => {
  const bytes = workbook();
  assert.equal(comparePayrollWorkbooks(bytes, bytes).changes.length, 0);
  assert.equal(parsePayrollWorkbook(bytes).sha256, parsePayrollWorkbook(bytes).sha256);
});

test("subida XLSX: actualizar el motivo permite conservar el mismo ajuste sobre la nueva fuente Workera", () => {
  const base = workbook({ automaticHH50Minutes: 120, adjustmentHH50: 30, adjustmentReasonHH50: "Motivo anterior" });
  const upload = workbook({ automaticHH50Minutes: 120, adjustmentHH50: 30, adjustmentReasonHH50: "Mantener decisión RR. HH." });
  const raw = comparePayrollWorkbooks(base, upload);
  const expanded = expandPayrollWorkbookBusinessChanges(base, raw.changes);
  const synthetic = expanded.find((change) => change.cell === "R6");

  assert.equal(raw.changes.some((change) => change.cell === "R6"), false);
  assert.equal(synthetic?.stableKey, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|Ajuste HH50 (minutos)");
  assert.equal(synthetic?.previous, 30);
  assert.equal(synthetic?.next, 30);
  assert.equal(synthetic?.sourceValueAtComparison, 120 / 1_440);
  assert.equal(synthetic?.consequence, "AJUSTE_EMPRESARIAL");
});

test("subida XLSX: normaliza una edición diaria por trabajador, fecha y campo estable", () => {
  const base = workbook({ dailyCode: "P" });
  const preview = comparePayrollWorkbooks(base, workbook({ dailyCode: "F-J" }));
  const change = preview.changes.find((item) => item.sheet === "MATRIZ_DIARIA_SABANA" && item.cell === "F6");

  assert.equal(change?.stableKey, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|2026-07-16|Código asistencia");
  assert.equal(change?.employeeName, "Persona uno");
  assert.equal(change?.workDate, "2026-07-16");
  assert.equal(change?.sourceValueAtComparison, "P");
  assert.equal(change?.consequence, "AJUSTE_EMPRESARIAL");
  assert.deepEqual(validatePayrollWorkbookBusinessChanges(base, preview.changes), []);

  const invalid = comparePayrollWorkbooks(base, workbook({ dailyCode: "R" }));
  assert.match(validatePayrollWorkbookBusinessChanges(base, invalid.changes).join(" "), /R no puede asignarse/);
});

test("subida XLSX: rechaza una celda diaria cuando cambió la identidad visible de su fila", () => {
  assert.throws(
    () => comparePayrollWorkbooks(workbook(), workbook({ matrixWorkerCode: "WK-OTRO", dailyCode: "F" })),
    /no coincide con ningún UUID del resumen/
  );
});

test("subida XLSX: sintetiza el motivo emparejado cuando cambia un ajuste numérico", () => {
  const base = workbook({ automaticHH50Minutes: 120, adjustmentReasonHH50: "Motivo conservado" });
  const raw = comparePayrollWorkbooks(base, workbook({ automaticHH50Minutes: 120, adjustmentHH50: -30, adjustmentReasonHH50: "Motivo conservado" }));
  const expanded = expandPayrollWorkbookBusinessChanges(base, raw.changes);
  const syntheticReason = expanded.find((change) => change.cell === "S6");
  assert.equal(syntheticReason?.next, "Motivo conservado");
  assert.equal(syntheticReason?.stableKey, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|Motivo ajuste HH50");
});

test("subida XLSX: KEEP_RRHH registra una resolución aunque el total visible no cambie", () => {
  const base = workbook({ automaticHH50Minutes: 120, adjustmentHH50: -30, adjustmentReasonHH50: "Pendiente de resolver" });
  const stableKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|Ajuste HH50 (minutos)";
  const changes = applyPayrollWorkbookConflictResolutions(base, [], [{
    stableKey,
    employeeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    employeeName: "Persona prueba",
    workDate: null,
    fieldCode: "Ajuste HH50 (minutos)",
    valueKind: "MINUTES",
    currentWorkeraValue: 120,
    rrhhFinalValue: 90,
  }], [{ stableKey, choice: "KEEP_RRHH", reason: "Mantener total de 90 minutos" }]);

  const adjustment = changes.find((change) => change.cell === "R6");
  const reason = changes.find((change) => change.cell === "S6");
  assert.equal(adjustment?.next, -30);
  assert.equal(adjustment?.sourceValueAtComparison, 120 / 1_440);
  assert.equal(adjustment?.conflictResolution, "KEEP_RRHH");
  assert.equal(reason?.next, "Mantener total de 90 minutos");
});

test("subida XLSX: una resolución diaria admite Workera o un tercer código y exige motivo", () => {
  const base = workbook({ dailyCode: "F-J" });
  const stableKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|2026-07-16|Código asistencia";
  const conflict = {
    stableKey,
    employeeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    employeeName: "Persona prueba",
    workDate: "2026-07-16",
    fieldCode: "Código asistencia",
    valueKind: "CODE" as const,
    currentWorkeraValue: "F",
    rrhhFinalValue: "F-J",
  };
  const accepted = applyPayrollWorkbookConflictResolutions(base, [], [conflict], [{ stableKey, choice: "ACCEPT_WORKERA", reason: "Aceptar la fuente vigente" }]);
  assert.equal(accepted.find((change) => change.cell === "F6")?.next, "F");
  assert.throws(() => applyPayrollWorkbookConflictResolutions(base, [], [conflict], []), /todos los conflictos vigentes/);
  assert.throws(
    () => applyPayrollWorkbookConflictResolutions(base, [], [conflict], [{ stableKey, choice: "THIRD_VALUE", thirdValue: "R", reason: "No permitido" }]),
    /código diario oficial/,
  );
});

test("subida XLSX: recalcula ajustes sin ejecutar fórmulas y bloquea finales negativos o sin motivo", () => {
  const base = workbook({ automaticHH50Minutes: 120 });
  const negative = workbook({ automaticHH50Minutes: 120, adjustmentHH50: -121, adjustmentReasonHH50: "corrección ficticia" });
  const negativePreview = comparePayrollWorkbooks(base, negative);
  assert.match(validatePayrollWorkbookBusinessChanges(base, negativePreview.changes).join(" "), /no puede ser negativo/);

  const withoutReason = workbook({ automaticHH50Minutes: 120, adjustmentHH50: -60 });
  const noReasonPreview = comparePayrollWorkbooks(base, withoutReason);
  assert.match(validatePayrollWorkbookBusinessChanges(base, noReasonPreview.changes).join(" "), /motivo.*obligatorio/);

  const valid = workbook({ automaticHH50Minutes: 120, adjustmentHH50: -60, adjustmentReasonHH50: "corrección ficticia" });
  const validPreview = comparePayrollWorkbooks(base, valid);
  assert.deepEqual(validatePayrollWorkbookBusinessChanges(base, validPreview.changes), []);
});

test("subida XLSX: rechaza archivo corrupto o sin firma ZIP", () => {
  assert.throws(() => inspectXlsxContainer(new Uint8Array([1, 2, 3, 4])), /firma/);
});

test("subida XLSX: rechaza rutas ZIP con traversal", () => {
  assert.throws(() => inspectXlsxContainer(zipSync({ "../escape.txt": strToU8("contenido") })), /ruta ZIP insegura/);
});

test("subida XLSX: rechaza un contenedor con macros", () => {
  assert.throws(() => parsePayrollWorkbook(zipSync({ "xl/vbaProject.bin": strToU8("macro") })), /macros/);
  assert.throws(() => parsePayrollWorkbook(zipSync({ "xl/embeddings/oleObject1.bin": strToU8("objeto") })), /objetos incrustados/);
});

test("subida XLSX: rechaza conexiones, consultas, modelos y metadatos activos OOXML", () => {
  for (const path of [
    "xl/connections.xml",
    "xl/queryTables/queryTable1.xml",
    "xl/pivotCache/pivotCacheDefinition1.xml",
    "xl/model/item.data",
    "xl/webextensions/webextension1.xml",
    "customXml/item1.xml",
  ]) {
    assert.throws(
      () => parsePayrollWorkbook(zipSync({ [path]: strToU8("contenido activo") })),
      /conexiones, consultas, modelos/,
      path,
    );
  }
});

test("subida XLSX: rechaza fórmulas externas en nombres definidos", () => {
  for (const reference of [
    "'[archivo-remoto.xlsx]Hoja1'!$A$1",
    'WEBSERVICE("https://example.invalid/nomina")',
    "cmd|' /C calc'!A0",
  ]) {
    assert.throws(
      () => parsePayrollWorkbook(workbook({ definedNameRef: reference })),
      /nombre definido externo o potencialmente ejecutable/,
      reference,
    );
  }
});

test("subida XLSX: rechaza relaciones externas", () => {
  for (const targetMode of [
    'TargetMode="External"',
    'TargetMode = "External"',
    'TargetMode = "Ext&#x65;rnal"',
  ]) {
    const relationship = `<Relationships><Relationship Target="https://example.test/data.xlsx" ${targetMode}/></Relationships>`;
    for (const path of ["_rels/.rels", "_rels/WORKBOOK.RELS"]) {
      assert.throws(
        () => parsePayrollWorkbook(zipSync({ [path]: strToU8(relationship) })),
        /relación externa/,
        `${path}: ${targetMode}`,
      );
    }
  }

  const utf16Xml = '<Relationships><Relationship Target="https://example.test/data.xlsx" TargetMode="External"/></Relationships>';
  const utf16Relationship = new Uint8Array([
    0xff,
    0xfe,
    ...Buffer.from(utf16Xml, "utf16le"),
  ]);
  assert.throws(
    () => parsePayrollWorkbook(zipSync({ "_rels/.rels": utf16Relationship })),
    /codificación no permitida/,
  );
});
