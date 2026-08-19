import type { AppRole } from "../../lib/supabase/authorize";

/**
 * Navegación por rol (Fase 8, PASO 3). Datos puros -- ninguna lógica de
 * negocio, solo qué enlaces existen para cada rol. La seguridad real sigue
 * siendo RLS/backend (cada página server-side vuelve a validar el rol antes
 * de renderizar); esto solo decide qué se OFRECE en el menú.
 */

export interface NavItem {
  label: string;
  href: string;
}

const SUPERVISOR_ITEMS: NavItem[] = [
  { label: "Mi equipo", href: "/dashboard" },
  { label: "Revisión diaria", href: "/revision-diaria" },
  { label: "Horas extra", href: "/revision-diaria?filtro=horas-extra" },
  { label: "Atrasos", href: "/revision-diaria?filtro=atrasos" },
  { label: "Ausencias / Licencias", href: "/revision-diaria?filtro=ausencias" },
  { label: "Documentos pendientes", href: "/revision-diaria?filtro=documentos" },
];

const RRHH_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Revisión diaria / Asistencia", href: "/revision-diaria" },
  { label: "Empleados", href: "/empleados" },
  { label: "Horas extra", href: "/revision-diaria?filtro=horas-extra" },
  { label: "Atrasos", href: "/revision-diaria?filtro=atrasos" },
  { label: "Ausencias / Licencias", href: "/revision-diaria?filtro=ausencias" },
  { label: "Documentos", href: "/revision-diaria?filtro=documentos" },
  { label: "Períodos", href: "/periodos" },
  { label: "Exportaciones", href: "/exportaciones" },
];

const SUPER_ADMIN_ITEMS: NavItem[] = [
  ...RRHH_ITEMS,
  { label: "Usuarios", href: "/usuarios" },
  { label: "Configuración", href: "/configuracion" },
];

export function getNavItemsForRole(role: AppRole): NavItem[] {
  switch (role) {
    case "SUPER_ADMIN":
      return SUPER_ADMIN_ITEMS;
    case "ADMIN_RRHH":
      return RRHH_ITEMS;
    case "SUPERVISOR_PRODUCTION":
    case "SUPERVISOR_INSTALLATION":
      return SUPERVISOR_ITEMS;
  }
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
