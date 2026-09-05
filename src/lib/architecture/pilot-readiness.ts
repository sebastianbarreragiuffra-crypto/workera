import {
  REQUEST_SURFACES,
  type RequestSurfaceBlocker,
  type RequestSurfaceDomain,
} from "./request-surfaces";
import {
  SERVER_ACTION_SURFACES,
  type ServerActionBlocker,
} from "./server-action-surfaces";
import {
  RPC_CONSUMER_SURFACES,
  STORAGE_CONSUMER_SURFACES,
  type DataSurfaceDomain,
  type DataSurfaceBlocker,
} from "./data-surfaces";

export type ReadinessGateStatus =
  | "VERIFIED_LOCAL"
  | "VERIFIED_HOSTED"
  | "ACCEPTED"
  | "OPEN_CODE"
  | "REQUIRES_HOSTED_EVIDENCE"
  | "REQUIRES_OWNER_DECISION";

export type ReadinessGateId =
  | "SOURCE_SURFACE_INVENTORY"
  | "FRESH_DATABASE_REHEARSAL"
  | "APPLICATION_QUALITY_GATES"
  | "SYNTHETIC_STAGING_DATA"
  | "APPLICATION_RATE_LIMIT"
  | "EDGE_RATE_LIMIT"
  | "ANTIMALWARE_PROVIDER"
  | "EXPORT_AUDIT"
  | "HOSTED_AUTH_CONTROLS"
  | "HOSTED_MFA_ROLLOUT"
  | "HOSTED_OBSERVABILITY"
  | "LABOR_MULTI_TENANCY"
  | "BACKUP_RESTORE_DRILL"
  | "PROVIDER_CANARIES"
  | "DAST_AND_PENTEST"
  | "LOAD_AND_SOAK"
  | "INCIDENT_RESPONSE"
  | "PRIVACY_AND_LEGAL"
  | "RESIDUAL_RISK_ACCEPTANCE"
  | "HIGH_AVAILABILITY_DECISION";

export interface ReadinessGate {
  readonly id: ReadinessGateId;
  readonly title: string;
  readonly status: ReadinessGateStatus;
  readonly owner: string;
  readonly evidence: readonly string[];
  readonly nextAction: string;
}

export type ReadinessStageId =
  | "LOCAL_SYNTHETIC"
  | "SANITIZED_STAGING"
  | "ARCOTEX_LABOR_PILOT"
  | "EXPENSES_PILOT"
  | "MULTI_COMPANY_PRODUCTION";

export type ReadinessDecision = "GO" | "NO_GO";
type SurfaceBlocker = RequestSurfaceBlocker | ServerActionBlocker | DataSurfaceBlocker;
type SurfaceDomain = RequestSurfaceDomain | DataSurfaceDomain;

interface StageDefinition {
  readonly id: ReadinessStageId;
  readonly title: string;
  readonly domains: readonly SurfaceDomain[];
  readonly baseGates: readonly ReadinessGateId[];
  readonly includeSurfaceBlockers: boolean;
  readonly excludedSurfaceBlockers: readonly SurfaceBlocker[];
  readonly hardConstraints: readonly string[];
}

export interface SurfaceBlockerOccurrence {
  readonly blocker: SurfaceBlocker;
  readonly gateId: ReadinessGateId;
  readonly domain: SurfaceDomain;
  readonly surfaceKind: "HTTP" | "SERVER_ACTION" | "RPC" | "STORAGE";
  readonly surface: string;
}

export interface StageReadiness {
  readonly id: ReadinessStageId;
  readonly title: string;
  readonly decision: ReadinessDecision;
  readonly closedGateCount: number;
  readonly requiredGateCount: number;
  readonly openGates: readonly ReadinessGate[];
  readonly requiredGates: readonly ReadinessGate[];
  readonly hardConstraints: readonly string[];
  readonly excludedSurfaceBlockers: readonly SurfaceBlocker[];
}

const CLOSED_STATUSES = new Set<ReadinessGateStatus>([
  "VERIFIED_LOCAL",
  "VERIFIED_HOSTED",
  "ACCEPTED",
]);

export const READINESS_GATES = [
  {
    id: "SOURCE_SURFACE_INVENTORY",
    title: "Inventarios ejecutables de HTTP, Actions, RPC y Storage",
    status: "VERIFIED_LOCAL",
    owner: "Architecture / Security",
    evidence: [
      "src/lib/architecture/request-surfaces.test.ts",
      "src/lib/architecture/server-action-surfaces.test.ts",
      "src/lib/architecture/data-surfaces.test.ts",
    ],
    nextAction: "Mantener los registros cerrados en cada cambio de superficie.",
  },
  {
    id: "FRESH_DATABASE_REHEARSAL",
    title: "Migraciones y pgTAP desde base vacía aislada",
    status: "VERIFIED_LOCAL",
    owner: "Data / Security",
    evidence: ["supabase/tests/077_platform_action_rate_limits.sql", "docs/LOCAL_SETUP.md"],
    nextAction: "Repetir en CI y antes de promover cada lote de migraciones.",
  },
  {
    id: "APPLICATION_QUALITY_GATES",
    title: "Tests, lint, tipos y build de producción",
    status: "VERIFIED_LOCAL",
    owner: "Engineering",
    evidence: ["package.json", "next.config.ts"],
    nextAction: "Ejecutar como checks obligatorios del commit desplegado.",
  },
  {
    id: "SYNTHETIC_STAGING_DATA",
    title: "Staging saneado y exclusivamente sintético",
    status: "REQUIRES_HOSTED_EVIDENCE",
    owner: "Platform / Privacy",
    evidence: ["docs/STAGING_ENVIRONMENT.md"],
    nextAction: "Clasificar los 97 registros existentes y limpiar o reemplazar el ambiente.",
  },
  {
    id: "APPLICATION_RATE_LIMIT",
    title: "Cuota faltante en una superficie de aplicación inventariada",
    status: "OPEN_CODE",
    owner: "Security / Engineering",
    evidence: ["docs/ABUSE_RATE_LIMITING_PLAN.md", "src/lib/architecture/request-surfaces.ts", "src/lib/architecture/server-action-surfaces.ts"],
    nextAction: "Implementar cualquier superficie futura que vuelva a declarar este bloqueo.",
  },
  {
    id: "EDGE_RATE_LIMIT",
    title: "Rate limit confiable en el borde público",
    status: "OPEN_CODE",
    owner: "Platform / Security",
    evidence: ["docs/API_SECURITY_STANDARD.md", "docs/ABUSE_RATE_LIMITING_PLAN.md"],
    nextAction: "Elegir el borde, su identidad de cliente confiable y probar 429/Retry-After.",
  },
  {
    id: "ANTIMALWARE_PROVIDER",
    title: "Antimalware/CDR conectado a cuarentena",
    status: "OPEN_CODE",
    owner: "Security / Expenses",
    evidence: ["docs/EXPENSE_FILE_QUARANTINE.md", "src/lib/expense-file-scan/worker.ts"],
    nextAction: "Seleccionar adapter real, definir retención y probar canarios del proveedor en staging aislado.",
  },
  {
    id: "EXPORT_AUDIT",
    title: "Auditoría completa de exportaciones",
    status: "OPEN_CODE",
    owner: "Security / Audit",
    evidence: ["docs/SECURITY_SURFACE_INVENTORY.md"],
    nextAction: "Cerrar cualquier export futuro que el inventario marque sin ledger.",
  },
  {
    id: "HOSTED_AUTH_CONTROLS",
    title: "Auth, CAPTCHA y límites verificados en Supabase hospedado",
    status: "REQUIRES_HOSTED_EVIDENCE",
    owner: "IAM / Platform",
    evidence: ["docs/ABUSE_RATE_LIMITING_PLAN.md", "docs/THREAT_MODEL_CURRENT.md"],
    nextAction: "Verificar valores reales, respuestas no enumerables y recuperación.",
  },
  {
    id: "HOSTED_MFA_ROLLOUT",
    title: "MFA AAL2 y recuperación owner ensayados",
    status: "REQUIRES_HOSTED_EVIDENCE",
    owner: "IAM / Platform",
    evidence: ["docs/PLATFORM_OWNER_RUNBOOK.md", "docs/MFA_DESIGN.md"],
    nextAction: "Ejecutar el rollout en dos pasos con dos TOTP y rollback disponible.",
  },
  {
    id: "HOSTED_OBSERVABILITY",
    title: "Telemetría, alertas y paging hospedados",
    status: "REQUIRES_HOSTED_EVIDENCE",
    owner: "SRE / Security",
    evidence: ["docs/THREAT_MODEL_CURRENT.md"],
    nextAction: "Configurar sink, SLI, alertas y demostrar que una falla despierta al responsable.",
  },
  {
    id: "LABOR_MULTI_TENANCY",
    title: "Aislamiento laboral demostrado con segunda empresa",
    status: "OPEN_CODE",
    owner: "Data Architecture / Workforce",
    evidence: ["README.md", "docs/PLATFORM_MULTI_COMPANY.md"],
    nextAction: "Completar MT-3B-D y pruebas negativas con un tenant sintético completo.",
  },
  {
    id: "BACKUP_RESTORE_DRILL",
    title: "Restore conjunto de DB y Storage con RPO/RTO",
    status: "REQUIRES_HOSTED_EVIDENCE",
    owner: "Platform / DR",
    evidence: ["docs/BACKUP_RECOVERY_PLAN.md"],
    nextAction: "Restaurar una copia aislada, verificar checksums y ensayar cutover/rollback.",
  },
  {
    id: "PROVIDER_CANARIES",
    title: "Canarios y rollback de proveedores reales",
    status: "REQUIRES_HOSTED_EVIDENCE",
    owner: "Integrations / Operations",
    evidence: ["docs/THREAT_MODEL_CURRENT.md"],
    nextAction: "Probar Workera/correo/WhatsApp/OCR/ERP por flag y reconciliar resultados.",
  },
  {
    id: "DAST_AND_PENTEST",
    title: "DAST y pentest autenticado multirol",
    status: "REQUIRES_HOSTED_EVIDENCE",
    owner: "Security",
    evidence: ["docs/THREAT_MODEL_CURRENT.md"],
    nextAction: "Ejecutar matriz ASVS L2 y pruebas IDOR/multitenant en el build candidato.",
  },
  {
    id: "LOAD_AND_SOAK",
    title: "Carga sintética y soak sin backlog sostenido",
    status: "REQUIRES_HOSTED_EVIDENCE",
    owner: "SRE / Product",
    evidence: ["docs/TARGET_ARCHITECTURE_PHASES_2_6.md"],
    nextAction: "Medir límites y ejecutar soak de 14 días sobre staging saneado.",
  },
  {
    id: "INCIDENT_RESPONSE",
    title: "Runbook de incidentes y tabletop",
    status: "REQUIRES_OWNER_DECISION",
    owner: "Security / Legal / Leadership",
    evidence: ["docs/THREAT_MODEL_CURRENT.md"],
    nextAction: "Asignar on-call, severidades, contactos, evidencia y practicar un incidente.",
  },
  {
    id: "PRIVACY_AND_LEGAL",
    title: "Privacidad, finalidad, retención y contratos",
    status: "REQUIRES_OWNER_DECISION",
    owner: "Privacy / Legal / Product",
    evidence: ["docs/THREAT_MODEL_CURRENT.md"],
    nextAction: "Cerrar RoPA/DPIA, derechos, transferencias, retención y avisos aplicables.",
  },
  {
    id: "RESIDUAL_RISK_ACCEPTANCE",
    title: "Aceptación formal del riesgo residual",
    status: "REQUIRES_OWNER_DECISION",
    owner: "Business / Security / Data Owners",
    evidence: ["docs/THREAT_MODEL_CURRENT.md"],
    nextAction: "Registrar owner, compensación, vencimiento y autoridad GO/NO-GO por riesgo.",
  },
  {
    id: "HIGH_AVAILABILITY_DECISION",
    title: "SLA, SPOF y recuperación regional aceptados",
    status: "REQUIRES_OWNER_DECISION",
    owner: "Leadership / Platform",
    evidence: ["docs/TARGET_ARCHITECTURE_PHASES_2_6.md"],
    nextAction: "Aprobar SLA/topología y ensayar la pérdida del proveedor o región.",
  },
] as const satisfies readonly ReadinessGate[];

export const BLOCKER_GATE_MAP = {
  ANTIMALWARE_PROVIDER: "ANTIMALWARE_PROVIDER",
  APPLICATION_RATE_LIMIT: "APPLICATION_RATE_LIMIT",
  EDGE_RATE_LIMIT: "EDGE_RATE_LIMIT",
  EXPORT_AUDIT: "EXPORT_AUDIT",
  HOSTED_AUTH_CONTROLS: "HOSTED_AUTH_CONTROLS",
  HOSTED_MFA_ROLLOUT: "HOSTED_MFA_ROLLOUT",
  HOSTED_OBSERVABILITY: "HOSTED_OBSERVABILITY",
  LABOR_MULTI_TENANCY: "LABOR_MULTI_TENANCY",
} as const satisfies Record<SurfaceBlocker, ReadinessGateId>;

const HOSTED_BASE_GATES = [
  "SOURCE_SURFACE_INVENTORY",
  "FRESH_DATABASE_REHEARSAL",
  "APPLICATION_QUALITY_GATES",
  "SYNTHETIC_STAGING_DATA",
  "HOSTED_AUTH_CONTROLS",
  "HOSTED_MFA_ROLLOUT",
  "HOSTED_OBSERVABILITY",
  "BACKUP_RESTORE_DRILL",
] as const satisfies readonly ReadinessGateId[];

const PILOT_BASE_GATES = [
  ...HOSTED_BASE_GATES,
  "PROVIDER_CANARIES",
  "DAST_AND_PENTEST",
  "LOAD_AND_SOAK",
  "INCIDENT_RESPONSE",
  "PRIVACY_AND_LEGAL",
  "RESIDUAL_RISK_ACCEPTANCE",
] as const satisfies readonly ReadinessGateId[];

export const READINESS_STAGES = [
  {
    id: "LOCAL_SYNTHETIC",
    title: "Desarrollo local con datos sintéticos",
    domains: [],
    baseGates: [
      "SOURCE_SURFACE_INVENTORY",
      "FRESH_DATABASE_REHEARSAL",
      "APPLICATION_QUALITY_GATES",
    ],
    includeSurfaceBlockers: false,
    excludedSurfaceBlockers: [],
    hardConstraints: [
      "Solo datos sintéticos; proveedores reales y flags de integración permanecen apagados.",
    ],
  },
  {
    id: "SANITIZED_STAGING",
    title: "Staging saneado para ensayo de seguridad",
    domains: [],
    baseGates: HOSTED_BASE_GATES,
    includeSurfaceBlockers: false,
    excludedSurfaceBlockers: [],
    hardConstraints: [
      "No ingresar PII ni activar conectores hasta cerrar los gates de su piloto específico.",
    ],
  },
  {
    id: "ARCOTEX_LABOR_PILOT",
    title: "Marcha blanca laboral limitada a ARCOTEX",
    domains: ["identity", "workforce"],
    baseGates: PILOT_BASE_GATES,
    includeSurfaceBlockers: true,
    excludedSurfaceBlockers: ["LABOR_MULTI_TENANCY"],
    hardConstraints: [
      "ARCOTEX debe seguir siendo el único workspace laboral habilitado.",
      "No habilitar una segunda empresa laboral hasta completar MT-3B-D.",
      "Toda decisión de remuneración o asistencia conserva revisión humana.",
    ],
  },
  {
    id: "EXPENSES_PILOT",
    title: "Piloto multiempresa del módulo Rendiciones",
    domains: ["identity", "expenses"],
    baseGates: PILOT_BASE_GATES,
    includeSurfaceBlockers: true,
    excludedSurfaceBlockers: [],
    hardConstraints: [
      "Activar el módulo por empresa y canal; nunca habilitar proveedores globalmente.",
      "OCR y asistente solo sugieren; pagos, rechazos y conciliación siguen humanos.",
    ],
  },
  {
    id: "MULTI_COMPANY_PRODUCTION",
    title: "Producción multiempresa completa",
    domains: ["identity", "platform", "workforce", "expenses"],
    baseGates: [...PILOT_BASE_GATES, "HIGH_AVAILABILITY_DECISION"],
    includeSurfaceBlockers: true,
    excludedSurfaceBlockers: [],
    hardConstraints: [
      "Cada módulo se habilita por entitlement y configuración, nunca mediante forks por cliente.",
      "El control plane no concede lectura implícita de datos empresariales.",
    ],
  },
] as const satisfies readonly StageDefinition[];

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function collectSurfaceBlockers(): SurfaceBlockerOccurrence[] {
  const occurrences: SurfaceBlockerOccurrence[] = [];
  for (const surface of REQUEST_SURFACES) {
    for (const blocker of surface.blockers) occurrences.push({
      blocker,
      gateId: BLOCKER_GATE_MAP[blocker],
      domain: surface.domain,
      surfaceKind: "HTTP",
      surface: `${surface.method} ${surface.route}`,
    });
  }
  for (const surface of SERVER_ACTION_SURFACES) {
    for (const blocker of surface.blockers) occurrences.push({
      blocker,
      gateId: BLOCKER_GATE_MAP[blocker],
      domain: surface.domain,
      surfaceKind: "SERVER_ACTION",
      surface: surface.source,
    });
  }
  for (const surface of RPC_CONSUMER_SURFACES) {
    for (const blocker of surface.blockers) occurrences.push({
      blocker,
      gateId: BLOCKER_GATE_MAP[blocker],
      domain: surface.domain,
      surfaceKind: "RPC",
      surface: surface.source,
    });
  }
  for (const surface of STORAGE_CONSUMER_SURFACES) {
    for (const blocker of surface.blockers) occurrences.push({
      blocker,
      gateId: BLOCKER_GATE_MAP[blocker],
      domain: surface.domain,
      surfaceKind: "STORAGE",
      surface: `${surface.source} :: ${surface.bucket}/${surface.operation}`,
    });
  }
  return occurrences;
}

export function evaluateReadiness(stageId: ReadinessStageId): StageReadiness {
  const stage = READINESS_STAGES.find((item) => item.id === stageId);
  if (!stage) throw new Error(`Etapa de readiness desconocida: ${stageId}`);

  const surfaceGates = stage.includeSurfaceBlockers
    ? collectSurfaceBlockers()
      .filter((item) => (stage.domains as readonly SurfaceDomain[]).includes(item.domain))
      .filter((item) => !(stage.excludedSurfaceBlockers as readonly SurfaceBlocker[]).includes(item.blocker))
      .map((item) => item.gateId)
    : [];
  const requiredIds = unique<ReadinessGateId>([...stage.baseGates, ...surfaceGates]);
  const gatesById = new Map(READINESS_GATES.map((gate) => [gate.id, gate] as const));
  const requiredGates = requiredIds.map((id) => {
    const gate = gatesById.get(id);
    if (!gate) throw new Error(`Gate de readiness sin definición: ${id}`);
    return gate;
  });
  const openGates = requiredGates.filter((gate) => !CLOSED_STATUSES.has(gate.status));

  return {
    id: stage.id,
    title: stage.title,
    decision: openGates.length === 0 ? "GO" : "NO_GO",
    closedGateCount: requiredGates.length - openGates.length,
    requiredGateCount: requiredGates.length,
    openGates,
    requiredGates,
    hardConstraints: stage.hardConstraints,
    excludedSurfaceBlockers: stage.excludedSurfaceBlockers,
  };
}

export function buildReadinessReport(): readonly StageReadiness[] {
  return READINESS_STAGES.map((stage) => evaluateReadiness(stage.id));
}

export function renderReadinessReport(report = buildReadinessReport()): string {
  const lines = [
    "GESTORA — decisión de preparación por alcance",
    "",
    ...report.flatMap((stage) => [
      `${stage.id}: ${stage.decision === "GO" ? "GO" : "NO-GO"} (${stage.closedGateCount}/${stage.requiredGateCount} gates cerrados)`,
      ...stage.openGates.map((gate) => `  - ${gate.id} [${gate.status}]: ${gate.nextAction}`),
      ...stage.hardConstraints.map((constraint) => `  ! ${constraint}`),
      "",
    ]),
  ];
  return lines.join("\n").trimEnd();
}
