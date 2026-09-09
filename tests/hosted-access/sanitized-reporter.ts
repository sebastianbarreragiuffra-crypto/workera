import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * Reporter deliberadamente mínimo para la ventana hospedada. Nunca imprime
 * errores, URLs, cuerpos, adjuntos ni trazas: sólo nombres estáticos de casos
 * y estados, que son los mismos datos permitidos en results.jsonl.
 */
export default class SanitizedHostedReporter implements Reporter {
  private total = 0;
  private passed = 0;

  onTestEnd(test: TestCase, result: TestResult) {
    this.total += 1;
    if (result.status === "passed") this.passed += 1;
    const caseName = test.titlePath().slice(1).join(" / ");
    process.stdout.write(`[hosted] ${result.status}: ${caseName}\n`);
  }

  async onEnd(result: FullResult) {
    const exactGatePassed = result.status === "passed" && this.total === 10 && this.passed === 10;
    process.stdout.write(`[hosted] resultado global: ${exactGatePassed ? "passed" : "failed"}; ${this.passed}/${this.total}\n`);
    if (!exactGatePassed) return { status: "failed" as const };
  }

  printsToStdio() {
    return true;
  }
}
