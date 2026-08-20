import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { ComingSoon } from "../../../components/shell/ComingSoon";

/**
 * "Usuarios" es administración de cuentas/roles -- capacidad exclusiva de
 * APP_ADMIN (Fase 8D, encargo explícito: ADMIN_RRHH no hereda capacidades
 * de APP_ADMIN). Antes de Fase 8D esta página también dejaba pasar
 * ADMIN_RRHH; se restringe acá porque coincide exactamente con la
 * categoría "user administration" del encargo.
 */
export default async function UsersPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN") redirect("/dashboard");

  return <ComingSoon title="Usuarios" />;
}
