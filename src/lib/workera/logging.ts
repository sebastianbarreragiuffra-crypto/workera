import "server-only";

/**
 * Logging seguro para operaciones del adaptador Workera (sección 32/33 del
 * encargo). Deliberadamente NO acepta un payload arbitrario — solo los
 * campos explícitamente listados abajo, para hacer estructuralmente
 * imposible loguear una API key, un header de autorización, un payload
 * completo de empleado o un RUT por accidente.
 */

export interface WorkeraLogEvent {
  correlationId: string;
  operation: string;
  statusCode?: number;
  durationMs?: number;
  outcome: "success" | "error";
  errorCode?: string;
}

/**
 * Correlation ID simple para poder rastrear "sync run -> request Workera ->
 * error de mapping" en los logs sin loguear datos sensibles (sección 33).
 * No es un sistema de tracing distribuido — un uuid por operación alcanza
 * para esta fase; no sobreingenierizar.
 */
export function createCorrelationId(): string {
  return crypto.randomUUID();
}

export function logWorkeraEvent(event: WorkeraLogEvent): void {
  // console.log estructurado por ahora — suficiente para esta fase. Si se
  // integra un proveedor de logs centralizado más adelante, este es el
  // único punto a cambiar.
  console.log("[workera]", JSON.stringify(event));
}
