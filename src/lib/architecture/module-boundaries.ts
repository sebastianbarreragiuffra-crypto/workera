/**
 * Mapa ejecutable de ownership de los módulos server-side.
 *
 * Las fronteras son deliberadamente gruesas durante el monolito modular. Un
 * directorio nuevo debe tener dueño explícito y ningún dominio puede depender
 * directamente de la implementación de otro dominio. La colaboración ocurre
 * por contratos compartidos, RPC/eventos o composición en `src/app`.
 */
export type ArchitecturalRealm = "governance" | "shared" | "platform" | "workforce" | "expenses";

export interface LibraryModuleDefinition {
  readonly realm: ArchitecturalRealm;
  readonly owner: string;
  readonly purpose: string;
}

export const LIBRARY_MODULES = {
  access: { realm: "workforce", owner: "workforce", purpose: "Ámbitos y roles laborales históricos" },
  admin: { realm: "platform", owner: "platform-security", purpose: "Operaciones administrativas privilegiadas" },
  architecture: { realm: "governance", owner: "architecture", purpose: "Fitness functions y contratos arquitectónicos" },
  auth: { realm: "shared", owner: "identity", purpose: "Sesión, MFA y autenticación común" },
  "business-rules": { realm: "workforce", owner: "workforce", purpose: "Reglas puras del dominio laboral" },
  colaciones: { realm: "workforce", owner: "workforce", purpose: "Beneficios y colaciones" },
  decisions: { realm: "workforce", owner: "workforce", purpose: "Decisiones y correcciones laborales" },
  employees: { realm: "workforce", owner: "workforce", purpose: "Maestro de personas del workspace laboral" },
  excel: { realm: "workforce", owner: "workforce", purpose: "Adaptadores Excel laborales heredados" },
  "expense-accounting": { realm: "expenses", owner: "expenses", purpose: "Outbox y adaptador contable" },
  "expense-assistant": { realm: "expenses", owner: "expenses", purpose: "Asistente de solo lectura y retención" },
  "expense-bank": { realm: "expenses", owner: "expenses", purpose: "Importación y conciliación bancaria" },
  "expense-capture": { realm: "expenses", owner: "expenses", purpose: "Persistencia privada de comprobantes" },
  "expense-email": { realm: "expenses", owner: "expenses", purpose: "Adaptador de ingreso por correo" },
  "expense-ocr": { realm: "expenses", owner: "expenses", purpose: "Extracción OCR asíncrona" },
  "expense-whatsapp": { realm: "expenses", owner: "expenses", purpose: "Adaptador de ingreso por WhatsApp" },
  expenses: { realm: "expenses", owner: "expenses", purpose: "Núcleo y casos de uso de rendiciones" },
  payroll: { realm: "workforce", owner: "workforce", purpose: "Nómina y proveedores laborales" },
  periods: { realm: "workforce", owner: "workforce", purpose: "Períodos laborales" },
  platform: { realm: "platform", owner: "platform", purpose: "Control plane multiempresa" },
  pwa: { realm: "shared", owner: "experience-platform", purpose: "Política PWA transversal" },
  "rule-engine": { realm: "workforce", owner: "workforce", purpose: "Límite privilegiado del motor laboral" },
  schedules: { realm: "workforce", owner: "workforce", purpose: "Administración de horarios" },
  shared: { realm: "shared", owner: "architecture", purpose: "Kernel mínimo sin conocimiento de dominios" },
  supabase: { realm: "shared", owner: "platform-engineering", purpose: "Acceso a datos, sesión y contratos generados" },
  sync: { realm: "workforce", owner: "workforce-integrations", purpose: "Orquestación de sincronización laboral" },
  tenant: { realm: "platform", owner: "platform", purpose: "Resolución de contexto empresarial" },
  "view-models": { realm: "workforce", owner: "workforce", purpose: "Proyecciones del workspace laboral" },
  workera: { realm: "workforce", owner: "workforce-integrations", purpose: "Adaptador Workera opcional" },
} as const satisfies Record<string, LibraryModuleDefinition>;

export const FORBIDDEN_REALM_DEPENDENCIES: Readonly<Record<ArchitecturalRealm, readonly ArchitecturalRealm[]>> = {
  governance: ["platform", "workforce", "expenses"],
  shared: ["platform", "workforce", "expenses"],
  platform: ["workforce", "expenses"],
  workforce: ["platform", "expenses"],
  expenses: ["platform", "workforce"],
};
