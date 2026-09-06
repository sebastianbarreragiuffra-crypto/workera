import assert from "node:assert/strict";
import test from "node:test";
import {
  renderPayrollSimulatorMarkdown,
  runPayrollSimulators,
  summarizePayrollSimulators,
  type PayrollSimulatorStatus,
} from "./payroll-simulators";

const VALID_STATUSES = new Set<PayrollSimulatorStatus>([
  "APROBADO",
  "FALLIDO",
  "PARCIAL",
  "NO_EJECUTADO",
]);

test("ejecuta exactamente los 30 simuladores del prompt, numerados y con evidencia", async () => {
  const results = await runPayrollSimulators();

  assert.equal(results.length, 30);
  assert.deepEqual(
    results.map((result) => result.numero),
    Array.from({ length: 30 }, (_, index) => index + 1)
  );
  for (const result of results) {
    assert.ok(result.situacion.length > 0, `simulador ${result.numero}: situación`);
    assert.ok(result.reglaValidada.length > 0, `simulador ${result.numero}: regla`);
    assert.notEqual(result.datosEntrada, undefined, `simulador ${result.numero}: entrada`);
    assert.notEqual(result.resultadoEsperado, undefined, `simulador ${result.numero}: esperado`);
    assert.notEqual(result.resultadoObtenido, undefined, `simulador ${result.numero}: obtenido`);
    assert.ok(VALID_STATUSES.has(result.estado), `simulador ${result.numero}: estado`);
    assert.ok(result.evidencia.length > 0, `simulador ${result.numero}: evidencia`);
    assert.ok(result.observaciones.length > 0, `simulador ${result.numero}: observaciones`);
  }

  const totals = summarizePayrollSimulators(results);
  assert.equal(
    totals.aprobados + totals.fallidos + totals.parciales + totals.noEjecutados,
    30
  );
  assert.equal(totals.fallidos, 0, "ninguna comprobación ejecutable puede quedar fallida");
  assert.equal(totals.aprobados, 21);
  assert.equal(totals.parciales, 9);
  assert.equal(totals.noEjecutados, 0);
  assert.deepEqual(
    results.filter((result) => result.estado === "PARCIAL").map((result) => result.numero),
    [2, 12, 19, 20, 23, 24, 25, 29, 30],
    "los alcances que dependen de render individual o infraestructura aislada no se sobredeclaran"
  );

  const minute59 = results[1];
  const obtained = minute59.resultadoObtenido as {
    evaluador: { minutosPagables: number };
  };
  assert.equal(obtained.evaluador.minutosPagables, 0);
  assert.equal(minute59.estado, "PARCIAL", "el rojo del caso individual no se sobredeclara sin render específico");
  assert.equal(results[19].estado, "PARCIAL", "la persistencia auditable del ajuste requiere base aislada");
  assert.equal(results[22].estado, "PARCIAL", "la descarga exacta de formato requiere Storage aislado");
  assert.equal(results[23].estado, "PARCIAL", "la reaplicación es pura, pero la descarga exacta requiere persistencia");
  assert.equal(results[24].estado, "PARCIAL", "el historial de una aprobación posterior requiere persistencia aislada");
  const updatedSource = results[24].resultadoObtenido as {
    ajusteAceptadoOriginal: number;
    valorFinalDecididoRRHH: number;
    fuenteActualizada: number;
    ajusteVisibleRebasado: number;
    totalFinalConservado: number;
    conflictoDetectadoPorMotor: boolean;
  };
  assert.deepEqual(
    {
      ajusteAceptadoOriginal: updatedSource.ajusteAceptadoOriginal,
      valorFinalDecididoRRHH: updatedSource.valorFinalDecididoRRHH,
      fuenteActualizada: updatedSource.fuenteActualizada,
      ajusteVisibleRebasado: updatedSource.ajusteVisibleRebasado,
      totalFinalConservado: updatedSource.totalFinalConservado,
      conflictoDetectadoPorMotor: updatedSource.conflictoDetectadoPorMotor,
    },
    {
      ajusteAceptadoOriginal: -30,
      valorFinalDecididoRRHH: 30,
      fuenteActualizada: 120,
      ajusteVisibleRebasado: -90,
      totalFinalConservado: 30,
      conflictoDetectadoPorMotor: true,
    },
    "una fuente nueva rebasa el delta para conservar el valor final decidido por RR. HH."
  );
  assert.equal(results[25].estado, "APROBADO", "el conflicto de tres vías debe materializarse en el libro regenerado");
  const conflict = results[25].resultadoObtenido as {
    ajusteProvisionalRebasado: number;
    totalFinalProvisional: number;
    resolucionesEjecutadas: Array<{
      eleccion: string;
      ajusteResultante: number;
      totalFinalResultante: number;
      aprobado: boolean;
    }>;
  };
  assert.equal(conflict.ajusteProvisionalRebasado, -30);
  assert.equal(conflict.totalFinalProvisional, 30);
  assert.deepEqual(
    conflict.resolucionesEjecutadas.map((resolution) => ({
      eleccion: resolution.eleccion,
      ajuste: resolution.ajusteResultante,
      total: resolution.totalFinalResultante,
      aprobado: resolution.aprobado,
    })),
    [
      { eleccion: "KEEP_RRHH", ajuste: -30, total: 30, aprobado: true },
      { eleccion: "ACCEPT_WORKERA", ajuste: 0, total: 60, aprobado: true },
      { eleccion: "THIRD_VALUE", ajuste: -15, total: 45, aprobado: true },
    ],
    "las tres opciones deben ejecutar el normalizador real, no inferirse desde un texto"
  );
  assert.ok(
    ["APROBADO", "PARCIAL"].includes(results[26].estado),
    "empresa y período se califican según la identidad real"
  );
  assert.equal(results[28].estado, "PARCIAL", "la concurrencia exige base aislada");
  assert.equal(results[29].estado, "PARCIAL", "el ciclo de aplicación se ejecuta; la persistencia integral exige base aislada");
  const close = results[29].resultadoObtenido as { cierreAplicacionEjecutado: boolean; bytesSubidosIgualesAlSnapshot: boolean; motivoReaperturaGuardado: string };
  assert.equal(close.cierreAplicacionEjecutado, true);
  assert.equal(close.bytesSubidosIgualesAlSnapshot, true);
  assert.equal(close.motivoReaperturaGuardado, "Corrección ficticia");
});

test("el informe Markdown contiene una tabla con exactamente 30 filas", async () => {
  const results = await runPayrollSimulators();
  const markdown = renderPayrollSimulatorMarkdown(results, {
    commit: "commit-ficticio",
    executedAt: "2026-09-06T12:00:00.000Z",
    resultsCorrespondExactlyToCommit: false,
    workingTreeStatus: "M archivo-ficticio.ts",
  });
  const dataRows = markdown
    .split("\n")
    .filter((line) => /^\| \d+ \|/.test(line));

  assert.equal(dataRows.length, 30);
  assert.match(markdown, /55 trabajadores ficticios/);
  assert.match(markdown, /pruebas automatizadas/);
  assert.match(markdown, /No se usó Supabase compartida ni datos productivos/);
  assert.match(markdown, /Correspondencia exacta con el commit: NO/);
  assert.doesNotMatch(markdown, /Correspondencia exacta con el commit: SÍ/);
});
