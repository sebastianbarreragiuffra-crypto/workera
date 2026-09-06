import "server-only";

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  renderPayrollSimulatorMarkdown,
  runPayrollSimulators,
  summarizePayrollSimulators,
} from "../src/lib/payroll/payroll-simulators";

const jsonPath = resolve(
  process.argv[2] ?? "outputs/payroll-audit-30/simuladores-pre-nomina-30.json"
);
const markdownPath = resolve(
  process.argv[3] ?? "outputs/payroll-audit-30/simuladores-pre-nomina-30.md"
);
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const workingTreeStatus = execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).trim();
const resultsCorrespondExactlyToCommit = workingTreeStatus === "";
const executedAt = new Date().toISOString();
const results = await runPayrollSimulators();
const totals = summarizePayrollSimulators(results);
const unresolved = results.filter((result) => result.estado !== "APROBADO");

const payload = {
  titulo: "Resultados de los 30 simuladores",
  executedAt,
  commit,
  resultsCorrespondExactlyToCommit,
  workingTreeStatus: workingTreeStatus || "clean",
  datos: "Exclusivamente ficticios",
  supabaseCompartidaUsada: false,
  datosProductivosUsados: false,
  distinciones: {
    simuladoresLaborales: results.length,
    trabajadoresFicticiosExcel: "Evidencia separada; no se contabilizan como simuladores",
    pruebasAutomatizadas: "Evidencia separada; no se contabilizan como simuladores",
  },
  totals,
  erroresEncontrados: unresolved.map((result) => ({
    simulador: result.numero,
    estado: result.estado,
    situacion: result.situacion,
    observaciones: result.observaciones,
  })),
  correccionesDeReglasAplicadasPorEsteEjecutor: [],
  confirmacionCommit: resultsCorrespondExactlyToCommit
    ? "Los 30 resultados fueron calculados al ejecutar exactamente el código del commit indicado."
    : "Los resultados fueron calculados sobre un árbol de trabajo con cambios y todavía no pueden atribuirse exactamente al commit indicado.",
  results,
};

await Promise.all([
  mkdir(dirname(jsonPath), { recursive: true }),
  mkdir(dirname(markdownPath), { recursive: true }),
]);
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8"),
  writeFile(
    markdownPath,
    renderPayrollSimulatorMarkdown(results, {
      commit,
      executedAt,
      resultsCorrespondExactlyToCommit,
      workingTreeStatus: workingTreeStatus || "clean",
    }),
    "utf8"
  ),
]);

console.log(
  JSON.stringify(
    {
      jsonPath,
      markdownPath,
      commit,
      executedAt,
      totals,
    },
    null,
    2
  )
);

if (totals.fallidos > 0) process.exitCode = 1;
