/**
 * Los 3 grupos reales de nuestra aplicación (docs/BUSINESS_RULES_PRE_PHASE2.md,
 * docs/DATA_MODEL_PHASE2B.md) — coinciden con el enum `app_role`/catálogo
 * `employee_groups` de la base de datos. Este archivo NO afirma que Workera
 * use estos mismos nombres; ver mappers/employee-group.ts para el mapeo.
 */
export type EmployeeGroupCode = "PRODUCTION" | "INSTALLATION" | "ADMINISTRATION";

export const EMPLOYEE_GROUP_CODES: readonly EmployeeGroupCode[] = [
  "PRODUCTION",
  "INSTALLATION",
  "ADMINISTRATION",
];

/**
 * Tabla de mapeo "nombre de grupo en Workera" -> EmployeeGroupCode. Se
 * inyecta como dependencia (no un objeto global hardcodeado) para que:
 *   - el mock pueda declarar su propio mapeo con sus propios nombres ficticios;
 *   - la configuración real (Fase 5) pueda cargarse desde variables de
 *     entorno o una tabla administrable sin tocar el código del mapper.
 * Sin entrada para un nombre dado => UNMAPPED (nunca se asigna un grupo al azar).
 */
export type EmployeeGroupMappingTable = Readonly<Record<string, EmployeeGroupCode>>;

/** Vacía por defecto: no hardcodeamos hipótesis de nombres reales de Workera (sección 10 del encargo) hasta confirmarlos. */
export const EMPTY_EMPLOYEE_GROUP_MAPPING: EmployeeGroupMappingTable = Object.freeze({});
