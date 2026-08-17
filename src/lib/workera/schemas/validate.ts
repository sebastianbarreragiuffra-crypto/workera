import type { z } from "zod";
import { WorkeraValidationError } from "../errors";

/**
 * Corre un schema Zod sobre un payload no confiable y lanza
 * WorkeraValidationError (WORKERA_PAYLOAD_VALIDATION_ERROR del encargo) con
 * el detalle de qué campo falló — nunca deja pasar el dato crudo hacia el
 * mapper si no cumple la forma esperada (sección 12 del encargo).
 */
export function validateWorkeraPayload<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  context: { operation: string }
): T {
  const result = schema.safeParse(payload);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));

    throw new WorkeraValidationError(
      `Payload de Workera inválido para "${context.operation}": no cumple la forma esperada.`,
      issues,
      { operation: context.operation, issueCount: issues.length }
    );
  }

  return result.data;
}
