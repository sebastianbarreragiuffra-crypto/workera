import type { AppRole } from "../../lib/supabase/authorize";

/**
 * Navegación por rol (Fase 8, reestructurada en Fase 8B.1). Datos puros --
 * ninguna lógica de negocio, solo qué enlaces existen para cada rol. La
 * seguridad real sigue siendo RLS/backend (cada página server-side vuelve a
 * validar el rol antes de renderizar); esto solo decide qué se OFRECE en el
 * menú.
 *
 * "Colaciones"/"Nómina de Pago"/"Rendiciones" son módulos futuros
 * explícitamente fuera de alcance de esta fase (PASO 3 del encargo): NO
 * tienen `href` real, solo `comingSoon: true` -- el Sidebar los renderiza
 * como texto no navegable con la etiqueta "Próximamente", nunca como un
 * link a una funcionalidad falsa. "Reportes"/"Historial de Decisiones"
 * comparten el mismo tratamiento: no existe todavía un servicio backend
 * agregado para ninguno de los dos.
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

const SUPERVISOR_MAIN: NavItem[] = [
  { label: "Resumen Diario", href: "/dashboard" },
  { label: "Mi Equipo", href: "/empleados" },
  { label: "Revisión Diaria", href: "/revision-diaria" },
  { label: "Atrasos", href: "/revision-diaria?filtro=atrasos" },
  { label: "Horas Extras", href: "/revision-diaria?filtro=horas-extra" },
  { label: "Clock Out Pendientes", href: "/revision-diaria?filtro=clock-out" },
  { label: "Ausencias / Licencias", href: "/revision-diaria?filtro=ausencias" },
];

const RRHH_MAIN: NavItem[] = [
  { label: "Resumen Diario", href: "/dashboard" },
  { label: "Empleados", href: "/empleados" },
  { label: "Revisión Diaria", href: "/revision-diaria" },
  { label: "Atrasos", href: "/revision-diaria?filtro=atrasos" },
  { label: "Horas Extras", href: "/revision-diaria?filtro=horas-extra" },
  { label: "Clock Out Pendientes", href: "/revision-diaria?filtro=clock-out" },
  { label: "Ausencias / Licencias", href: "/revision-diaria?filtro=ausencias" },
  { label: "Documentos", href: "/revision-diaria?filtro=documentos" },
];

const FUTURE_MODULES: NavItem[] = [
  { label: "Colaciones", href: "", comingSoon: true },
  { label: "Nómina de Pago", href: "", comingSoon: true },
  { label: "Rendiciones", href: "", comingSoon: true },
];

const REPORTS_SECTION_SUPERVISOR: NavItem[] = [{ label: "Historial de Decisiones", href: "", comingSoon: true }];

const REPORTS_SECTION_RRHH: NavItem[] = [
  { label: "Períodos", href: "/periodos" },
  { label: "Exportaciones", href: "/exportaciones" },
  { label: "Reportes", href: "", comingSoon: true },
  { label: "Historial de Decisiones", href: "", comingSoon: true },
];

export function getNavSectionsForRole(role: AppRole): NavSection[] {
  switch (role) {
    case "SUPER_ADMIN":
      return [
        { items: RRHH_MAIN },
        { items: FUTURE_MODULES, heading: "Próximamente" },
        { items: [...REPORTS_SECTION_RRHH, { label: "Usuarios", href: "/usuarios" }, { label: "Configuración", href: "/configuracion" }], heading: "Administración" },
      ];
    case "ADMIN_RRHH":
      return [
        { items: RRHH_MAIN },
        { items: FUTURE_MODULES, heading: "Próximamente" },
        { items: REPORTS_SECTION_RRHH, heading: "Administración" },
      ];
    case "SUPERVISOR_PRODUCTION":
    case "SUPERVISOR_INSTALLATION":
      return [
        { items: SUPERVISOR_MAIN },
        { items: FUTURE_MODULES, heading: "Próximamente" },
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
