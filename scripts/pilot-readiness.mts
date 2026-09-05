import {
  buildReadinessReport,
  renderReadinessReport,
  type ReadinessStageId,
} from "../src/lib/architecture/pilot-readiness";

const report = buildReadinessReport();
const json = process.argv.includes("--json");
const enforceArgument = process.argv.find((argument) => argument.startsWith("--enforce="));

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${renderReadinessReport(report)}\n`);
}

if (enforceArgument) {
  const stageId = enforceArgument.slice("--enforce=".length) as ReadinessStageId;
  const stage = report.find((item) => item.id === stageId);
  if (!stage) {
    process.stderr.write(`Etapa inválida para --enforce: ${stageId}\n`);
    process.exitCode = 2;
  } else if (stage.decision !== "GO") {
    process.stderr.write(`${stage.id} continúa en NO-GO: ${stage.openGates.length} gates abiertos.\n`);
    process.exitCode = 1;
  }
}
