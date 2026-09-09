import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

/**
 * Reporter deliberadamente mínimo para la ventana hospedada. Nunca imprime
 * errores, URLs, cuerpos, adjuntos ni trazas: sólo nombres estáticos de casos
 * y estados, que son los mismos datos permitidos en results.jsonl.
 */
export default class SanitizedHostedReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult) {
    const caseName = test.titlePath().slice(1).join(" / ");
    process.stdout.write(`[hosted] ${result.status}: ${caseName}\n`);
  }

  onEnd(result: FullResult) {
    process.stdout.write(`[hosted] resultado global: ${result.status}\n`);
  }

  printsToStdio() {
    return true;
  }
}
