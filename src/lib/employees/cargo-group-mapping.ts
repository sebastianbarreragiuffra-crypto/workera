/**
 * Mapeo centralizado y EXPLÍCITO de "CARGO" (planilla de personal) a área
 * (`employee_groups.code`). Enumerado a partir del archivo real
 * "LISTA DEL PERSONAL 17-08-26.xls" (44 trabajadores, 9 valores de CARGO
 * distintos) -- nunca se infiere el área desde el nombre, cargo no
 * catalogado, ni patrón de asistencia.
 *
 * Un CARGO sin mapeo explícito NUNCA se adivina -- el empleado queda
 * `employee_group_id = null` (SIN ASIGNAR) y se reporta para confirmación
 * de negocio (ARCOTEX), nunca se inventa una categoría.
 */

export type EmployeeGroupCode = "PRODUCTION" | "INSTALLATION" | "ADMINISTRATION";

/**
 * Confirmados a partir del archivo real. "GERENTE GENERAL" se mapea a
 * ADMINISTRATION -- razonable (gerencia general es función administrativa)
 * pero no 100% inequívoco solo por el texto; documentado como tal, no una
 * inferencia oculta.
 */
const CARGO_TO_GROUP: Record<string, EmployeeGroupCode> = {
  "OPERARIO DE PRODUCCION": "PRODUCTION",
  "SUPERVISOR DE PRODUCCION": "PRODUCTION",
  INSTALACION: "INSTALLATION",
  "SUPERVISOR DE INSTALACION": "INSTALLATION",
  ADMINISTRATIVO: "ADMINISTRATION",
  "SUPERVISOR DE ADMINISTRACION": "ADMINISTRATION",
  "GERENTE GENERAL": "ADMINISTRATION",
};

/**
 * Deliberadamente SIN mapear -- no hay una palabra clave de área en el texto
 * ("aseo"/"prevención de riesgos" no son Producción/Instalación/Administración
 * por sí mismos). Quedan documentados acá para que quede explícito que no se
 * olvidaron, sino que se decidió NO adivinar.
 */
export const UNMAPPED_CARGO_VALUES = ["AUXILIAR DE ASEO", "PREVENCIONISTA DE RIESGOS"];

function normalizeCargo(cargo: string): string {
  return cargo
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

/** null = sin mapeo conocido -> el llamador debe tratarlo como SIN ASIGNAR, nunca como error fatal. */
export function mapCargoToGroup(cargo: string): EmployeeGroupCode | null {
  return CARGO_TO_GROUP[normalizeCargo(cargo)] ?? null;
}

export function describeCargoMapping(cargoValues: string[]): { cargo: string; group: EmployeeGroupCode | null }[] {
  return cargoValues.map((cargo) => ({ cargo, group: mapCargoToGroup(cargo) }));
}
