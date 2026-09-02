import type { AppRole } from "../../lib/supabase/authorize";

/**
 * Navegación por rol (Fase 8, reestructurada en Fase 8B.1). Datos puros --
 * ninguna lógica de negocio, solo qué enlaces existen para cada rol. La
 * seguridad real sigue siendo RLS/backend (cada página server-side vuelve a
 * validar el rol antes de renderizar); esto solo decide qué se OFRECE en el
 * menú.
 *
 * "Rendiciones" sigue siendo un módulo futuro (sin `href` real, solo
 * `comingSoon: true` -- el Sidebar lo renderiza como texto no navegable con
 * la etiqueta "Próximamente", nunca como un link a una funcionalidad
 * falsa). "Reportes"/"Historial de Decisiones" comparten el mismo
 * tratamiento -- no existe todavía un servicio backend agregado para
 * ninguno de los dos. "Nómina de Pago" ya es una función real (RRHH/
 * SUPER_ADMIN únicamente -- datos financieros/bancarios de proveedores,
 * nunca visibles para supervisores de área).
 */

export interface NavItem {
  label: string;
  href: string;
  comingSoon?: boolean;
}

export interface NavSection {
  items: NavItem[];
  /** Encabezado visual opcional para agrupar (ej. separador antes de "Próximamente"). */
  heading?: string;
}

/**
 * "Pendientes" (antes "Revisión Diaria" + 4 entradas separadas por filtro --
 * consolidado porque nunca fueron módulos distintos, solo filtros de la
 * misma cola de trabajo interactiva). La ruta sigue siendo `/revision-diaria`
 * a propósito -- renombrar la ruta solo por estética generaría una migración
 * innecesaria; los filtros (`?filtro=atrasos`, etc.) siguen funcionando
 * igual, solo dejaron de tener su propia entrada en el menú principal (ver
 * `FilterBar` dentro de la página, y los KPI del dashboard que enlazan
 * directo a esos query params).
 */
/**
 * "Licencias" (antes "Trabajadores" + "Licencias" como entradas separadas)
 * -- consolidado: `/licencias` ahora es el directorio de empleados completo
 * (reutilizado tal cual desde la antigua `/empleados`, ver
 * `EmployeeDirectory`) MÁS la gestión de licencias médicas. `/empleados`
 * sigue existiendo como ruta (redirige a `/licencias`, por estabilidad de
 * enlaces antiguos) pero ya no tiene entrada propia en el menú.
 */
const SUPERVISOR_MAIN: NavItem[] = [
  { label: "Resumen Diario", href: "/dashboard" },
  { label: "Pendientes", href: "/revision-diaria" },
  { label: "Licencias", href: "/licencias" },
];

const RRHH_MAIN: NavItem[] = [
  { label: "Resumen Diario", href: "/dashboard" },
  { label: "Pendientes", href: "/revision-diaria" },
  { label: "Licencias", href: "/licencias" },
  { label: "Colaciones", href: "/colaciones" },
  { label: "Nómina de Pago", href: "/nomina-de-pago" },
];

const FUTURE_MODULES: NavItem[] = [{ label: "Rendiciones", href: "", comingSoon: true }];

const SUPERVISOR_FUTURE_MODULES: NavItem[] = [
  { label: "Colaciones", href: "", comingSoon: true },
  ...FUTURE_MODULES,
];

const REPORTS_SECTION_SUPERVISOR: NavItem[] = [{ label: "Historial de Decisiones", href: "", comingSoon: true }];

const REPORTS_SECTION_RRHH: NavItem[] = [
  // "Horarios" es administración de datos maestros, no un reporte -- vive en
  // esta sección porque es donde RRHH ya busca lo administrativo, y porque su
  // RLS es la misma `is_privileged_admin()` que el resto del bloque.
  { label: "Horarios", href: "/configuracion/horarios" },
  { label: "Motor de reglas", href: "/configuracion/motor-de-reglas" },
  { label: "Períodos", href: "/periodos" },
  { label: "Exportaciones", href: "/exportaciones" },
  { label: "Reportes", href: "", comingSoon: true },
  { label: "Historial de Decisiones", href: "", comingSoon: true },
];

export function getNavSectionsForRole(role: AppRole, options?: { expensesHref?: string | null }): NavSection[] {
  const expenseItems: NavItem[] = options?.expensesHref
    ? [{ label: "Rendiciones", href: options.expensesHref }]
    : FUTURE_MODULES;
  const supervisorModuleItems: NavItem[] = options?.expensesHref
    ? [{ label: "Colaciones", href: "", comingSoon: true }, ...expenseItems]
    : SUPERVISOR_FUTURE_MODULES;
  const moduleHeading = options?.expensesHref ? "Finanzas" : "Próximamente";
  switch (role) {
    case "SUPER_ADMIN":
      return [
        { items: RRHH_MAIN },
        { items: expenseItems, heading: moduleHeading },
        { items: [...REPORTS_SECTION_RRHH, { label: "Usuarios", href: "/usuarios" }, { label: "Configuración", href: "/configuracion" }], heading: "Administración" },
      ];
    case "ADMIN_RRHH":
      return [
        { items: RRHH_MAIN },
        { items: expenseItems, heading: moduleHeading },
        { items: REPORTS_SECTION_RRHH, heading: "Administración" },
      ];
    case "SUPERVISOR_PRODUCTION":
    case "SUPERVISOR_INSTALLATION":
      return [
        { items: SUPERVISOR_MAIN },
        { items: supervisorModuleItems, heading: moduleHeading },
        { items: REPORTS_SECTION_SUPERVISOR, heading: "Reportes" },
      ];
  }
}

/** Aplanado, usado por tests y por cualquier consumidor que solo necesite la lista de links navegables. */
export function getNavItemsForRole(role: AppRole): NavItem[] {
  return getNavSectionsForRole(role)
    .flatMap((section) => section.items)
    .filter((item) => !item.comingSoon);
}

export function roleLabel(role: AppRole): string {
  switch (role) {
    case "SUPER_ADMIN":
      return "Super administrador";
    case "ADMIN_RRHH":
      return "RRHH";
    case "SUPERVISOR_PRODUCTION":
      return "Supervisor Producción";
    case "SUPERVISOR_INSTALLATION":
      return "Supervisor Instalación";
  }
}
