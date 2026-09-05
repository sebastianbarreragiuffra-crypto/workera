import {
  buildStagingDataInventoryReport,
  renderStagingDataInventoryReport,
} from "../src/lib/staging-preflight/inventory";
import { collectStagingDataInventory } from "../src/lib/staging-preflight/service";

const observations = await collectStagingDataInventory();
const report = buildStagingDataInventoryReport(process.env, observations);

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${renderStagingDataInventoryReport(report)}\n`);
}

if (report.outcome !== "READY_FOR_SYNTHETIC_SEED") {
  process.exitCode = 1;
}
