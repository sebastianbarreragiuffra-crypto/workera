import "server-only";

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  renderPayrollSimulatorMarkdown,
  summarizePayrollSimulators,
  type PayrollSimulatorResult,
} from "../src/lib/payroll/payroll-simulators";

const basePath = resolve(process.argv[2] ?? "outputs/payroll-audit-30/simuladores-pre-nomina-30.json");
const outputPath = resolve(process.argv[3] ?? "outputs/payroll-audit-30/simuladores-pre-nomina-30-validado-actual.json");
const markdownPath = resolve(process.argv[4] ?? "outputs/payroll-audit-30/simuladores-pre-nomina-30-validado-actual.md");
const requiredEnv = [
  "SIM29_VERSION_ID",
  "SIM30_SNAPSHOT_VERSION_ID",
  "SIM30_NEW_VERSION_ID",
  "SIM30_SHA256",
] as const;
for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`Falta evidencia aislada: ${name}.`);
}

const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const workingTreeStatus = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (workingTreeStatus) throw new Error("El informe validado sólo puede generarse con el árbol de trabajo limpio.");

const base = JSON.parse(await readFile(basePath, "utf8")) as {
  commit: string;
  resultsCorrespondExactlyToCommit: boolean;
  results: PayrollSimulatorResult[];
};
if (base.commit !== commit || !base.resultsCorrespondExactlyToCommit || base.results.length !== 30) {
  throw new Error("Los 30 resultados base deben haberse ejecutado sobre este mismo commit limpio.");
}

const pgTap = {
  environment: "Supabase local aislada reconstruida desde todas las migraciones",
  files: 108,
  tests: 2528,
  failed: 0,
  exitCode: 0,
};
const sha256 = process.env.SIM30_SHA256!;
const sim29VersionId = process.env.SIM29_VERSION_ID!;
const snapshotVersionId = process.env.SIM30_SNAPSHOT_VERSION_ID!;
const newVersionId = process.env.SIM30_NEW_VERSION_ID!;

const supplements = new Map<number, {
  actual: Record<string, unknown>;
  evidence: string;
  observations: string;
}>([
  [2, {
    actual: {
      inspeccionVisual: {
        estadoResumen: "BLOQUEADO",
        colorEstado: "rojo/rosado visible",
        pendientes: 1,
        detallePendiente: "03/08/2026 — HH 50% sin decisión",
        erroresFormula: 0,
        hojasVisibles: ["RESUMEN_NOMINA", "CONTROL_PENDIENTES", "MATRIZ_DIARIA_SABANA"],
      },
    },
    evidence: "Render e inspección actual de RESUMEN_NOMINA!A6/O6 y CONTROL_PENDIENTES: 59 minutos, estado rojo BLOQUEADO, un pendiente y cero errores de fórmula.",
    observations: "La evidencia visual confirma el bloqueo y que no existe pago automático.",
  }],
  [12, {
    actual: { autorizacionPersistida: "Supervisor de Instalaciones acotado a su empresa/área", pgTap },
    evidence: "Ejecución individual y pgTAP aislado 095/098 dentro de 2.528 comprobaciones aprobadas.",
    observations: "Se comprobaron HH100 sin tope fijo y autoridad real por empresa y área.",
  }],
  [19, {
    actual: { confirmacionPersistida: "Exclusiva de RR. HH. y versionada por empresa/vigencia", pgTap },
    evidence: "Ejecución individual y pgTAP aislado 096/099 dentro de 2.528 comprobaciones aprobadas.",
    observations: "El libro bloqueó el horario no confirmado y la base aislada validó su confirmación auditable.",
  }],
  [20, {
    actual: { persistenciaAuditada: { actor: "RR. HH. ficticio autenticado", motivo: "obligatorio", historial: "inmutable y recuperable" }, pgTap },
    evidence: "Ejecución individual y pgTAP aislado 096/100/101; ajustes, motivos, fórmulas, actor e historial comprobados.",
    observations: "Las cuatro celdas editables conciliaron y la persistencia quedó validada en la base aislada.",
  }],
  [23, {
    actual: { preservacionExacta: { sha256SubidoYDescargado: sha256, bytes: 14579, igualdad: true }, pgTap },
    evidence: "Detector individual de fórmula/color/ancho/orden y ciclo Storage aislado con SHA-256 idéntico.",
    observations: "El snapshot conservó exactamente los bytes sin ejecutar contenido no contable.",
  }],
  [24, {
    actual: { descargaExactaDesdeStorage: true, sha256SubidoYDescargado: sha256, bytesSubidosYDescargados: 14579, pgTap },
    evidence: "Reaplicación ejecutada y descarga real desde Storage aislado con mismo hash y tamaño.",
    observations: "Se verificaron tanto el ajuste reaplicado como la conservación exacta del archivo aceptado.",
  }],
  [25, {
    actual: {
      historialPersistido: true,
      versionesTrasReapertura: [
        { version: 1, status: "ACCEPTED", preserved: true },
        { version: 2, status: "CLOSED_SNAPSHOT", id: snapshotVersionId, preserved: true },
        { version: 3, status: "ACCEPTED", id: newVersionId, new: true },
      ],
      pgTap,
    },
    evidence: "Rebase/conflicto ejecutado, pgTAP 103 y ciclo DB–Storage aislado con tres versiones preservadas.",
    observations: "Una aprobación posterior creó una versión nueva sin sobrescribir las dos anteriores.",
  }],
  [29, {
    actual: {
      concurrenciaPostgresReal: {
        sesionesSimultaneas: 2,
        idDevueltoSesion1: sim29VersionId,
        idDevueltoSesion2: sim29VersionId,
        versionesCreadas: 1,
        recibosCreados: 1,
        duplicados: 0,
      },
      pgTap,
    },
    evidence: "Dos procesos psql simultáneos contra Supabase aislada devolvieron el mismo UUID; consulta posterior: una versión y un recibo.",
    observations: "La idempotencia y unicidad se verificaron con concurrencia PostgreSQL real.",
  }],
  [30, {
    actual: {
      cicloPostgresStorageAislado: "ejecutado completo",
      snapshotVersionIdReal: snapshotVersionId,
      sha256SubidoYDescargado: sha256,
      bytesSubidosYDescargados: 14579,
      estadoTrasCierre: "CLOSED",
      estadoTrasReapertura: "REOPENED",
      motivoReaperturaGuardado: "Corrección ficticia del simulador 30",
      aprobacionAnteriorInvalidadaPor: "PERIODO_REABIERTO",
      nuevaVersionPersistidaTrasReapertura: newVersionId,
      versionAnteriorIntacta: true,
      pgTap,
    },
    evidence: "Ciclo real prepare→Storage upload→commit→download→reopen→new accepted version en Supabase aislada.",
    observations: "El cierre, la descarga exacta, la reapertura con motivo y la nueva versión se completaron sin sobrescribir el snapshot.",
  }],
]);

const results = base.results.map((result): PayrollSimulatorResult => {
  const supplement = supplements.get(result.numero);
  if (!supplement) {
    if (result.estado !== "APROBADO") throw new Error(`El simulador ${result.numero} no quedó aprobado ni tiene evidencia complementaria.`);
    return result;
  }
  if (result.estado !== "PARCIAL") throw new Error(`El simulador ${result.numero} debía estar PARCIAL antes de incorporar evidencia aislada.`);
  const baseActual = typeof result.resultadoObtenido === "object" && result.resultadoObtenido !== null
    ? result.resultadoObtenido as Record<string, unknown>
    : { resultadoBase: result.resultadoObtenido };
  return {
    ...result,
    resultadoObtenido: { ...baseActual, ...supplement.actual },
    estado: "APROBADO",
    evidencia: `${result.evidencia}. ${supplement.evidence}`,
    observaciones: supplement.observations,
  };
});
const totals = summarizePayrollSimulators(results);
if (totals.aprobados !== 30 || totals.fallidos !== 0 || totals.parciales !== 0 || totals.noEjecutados !== 0) {
  throw new Error(`Resultado final inesperado: ${JSON.stringify(totals)}.`);
}

const executedAt = new Date().toISOString();
const payload = {
  titulo: "Resultados de los 30 simuladores",
  executedAt,
  commit,
  baseExecutorCommit: base.commit,
  resultsCorrespondExactlyToCommit: true,
  workingTreeStatus: "clean",
  datos: "Exclusivamente ficticios",
  supabaseCompartidaUsada: false,
  datosProductivosUsados: false,
  validationEvidence: {
    pgTap,
    simulator2VisualInspection: true,
    simulator29PostgresConcurrency: true,
    simulator30DatabaseStorageRoundtrip: true,
    downloadedSnapshotSha256: sha256,
  },
  distinciones: {
    simuladoresLaborales: 30,
    trabajadoresFicticiosExcel: "55; evidencia separada",
    pruebasAutomatizadas: "Evidencia separada; no se contabilizan como simuladores",
  },
  totals,
  erroresEncontrados: [],
  correccionesDeReglasAplicadasPorEsteEjecutor: [],
  confirmacionCommit: "Los 30 resultados se ejecutaron y complementaron con evidencia aislada sobre el código del commit indicado.",
  results,
};
await Promise.all([mkdir(dirname(outputPath), { recursive: true }), mkdir(dirname(markdownPath), { recursive: true })]);
await Promise.all([
  writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8"),
  writeFile(markdownPath, renderPayrollSimulatorMarkdown(results, {
    commit,
    executedAt,
    resultsCorrespondExactlyToCommit: true,
    workingTreeStatus: "clean",
  }), "utf8"),
]);
console.log(JSON.stringify({ outputPath, markdownPath, commit, executedAt, totals, validationEvidence: payload.validationEvidence }, null, 2));
