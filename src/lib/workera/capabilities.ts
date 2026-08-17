/**
 * Capacidades confirmadas/no confirmadas de la API real de Workera.
 *
 * TODO lo que sigue en 'UNKNOWN' hasta que tengamos documentación/acceso real
 * (Fase 5) — no se afirma que Workera soporte nada de esto todavía. Ver
 * docs/WORKERA_API_REQUIREMENTS.md para el checklist completo de lo que
 * necesitamos que Workera confirme.
 *
 * Uso previsto: `createWorkeraClient()` y el futuro `HttpWorkeraClient`
 * consultan esto para decidir si una operación puede intentarse contra la
 * API real o debe fallar explícitamente en vez de asumir soporte.
 */

export type CapabilityStatus =
  | "UNKNOWN"
  | "CONFIRMED_AVAILABLE"
  | "CONFIRMED_UNAVAILABLE";

export interface WorkeraCapabilities {
  employees: CapabilityStatus;
  attendance: CapabilityStatus;
  absences: CapabilityStatus;
  /** Workera podría no calcular ni exponer horas extra en absoluto — ver docs/BUSINESS_RULES_PRE_PHASE2.md, es dominio nuestro por defecto. */
  overtime: CapabilityStatus;
  /** docs/PRE_FASE2_WORKERA_VALIDATION.md sección 6: nuestra base es la fuente de verdad operativa; esto es solo sobre si Workera además lo expone como semilla. */
  supervisors: CapabilityStatus;
  writeOvertimeApproval: CapabilityStatus;
  pagination: CapabilityStatus;
  webhooks: CapabilityStatus;
}

export const WORKERA_CAPABILITIES: Readonly<WorkeraCapabilities> = Object.freeze({
  employees: "UNKNOWN",
  attendance: "UNKNOWN",
  absences: "UNKNOWN",
  overtime: "UNKNOWN",
  supervisors: "UNKNOWN",
  writeOvertimeApproval: "UNKNOWN",
  pagination: "UNKNOWN",
  webhooks: "UNKNOWN",
});

/** true solo si la capacidad fue confirmada explícitamente como disponible — nunca por omisión. */
export function isCapabilityConfirmed(capability: CapabilityStatus): boolean {
  return capability === "CONFIRMED_AVAILABLE";
}
