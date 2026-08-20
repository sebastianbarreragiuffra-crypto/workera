import "server-only";
import { createClient as createSessionClient } from "./server";
import type { Database } from "./database.types";

/**
 * Verificación de autorización basada en la SESIÓN REAL del llamador
 * (cookies, sujeta a RLS) -- nunca en el cliente admin/service_role.
 * Extraído de src/lib/admin/user-management.ts (Fase 5D) para que
 * src/lib/sync/scheduler.ts (Fase 6B, rerun manual) reutilice exactamente
 * el mismo criterio en vez de duplicarlo por segunda vez.
 */

export type AppRole = Database["public"]["Enums"]["app_role"];

export class AuthorizationError extends Error {}

export async function requireCurrentRole(
  ...allowedRoles: AppRole[]
): Promise<{ actorId: string; actorRole: AppRole }> {
  const session = await createSessionClient();
  const { data: authData, error: authError } = await session.auth.getClaims();
  const actorId = authData?.claims?.sub as string | undefined;

  if (authError || !actorId) {
    throw new AuthorizationError("No hay sesión autenticada.");
  }

  const { data: profile, error: profileError } = await session
    .from("profiles")
    .select("role")
    .eq("id", actorId)
    .single();

  if (profileError || !profile?.role || !allowedRoles.includes(profile.role)) {
    throw new AuthorizationError(`Esta operación requiere uno de estos roles: ${allowedRoles.join(", ")}.`);
  }

  return { actorId, actorRole: profile.role };
}

/**
 * Gate de las capacidades de administración de aplicación (Fase 8D --
 * gestión de usuarios, asignación/cambio de rol, configuración privilegiada,
 * módulos/integraciones, y cualquier configuración de layout/tema que se
 * exponga a futuro). "APP_ADMIN" es un concepto de UI/negocio, NO un valor
 * nuevo de `app_role` -- el rol técnico sigue siendo SUPER_ADMIN (ya
 * modelado en Fase 5D con su propia RLS y protección del último admin
 * activo); esta función es el único lugar del código de aplicación que
 * declara esa equivalencia, para que ningún otro archivo tenga que repetir
 * el string `"SUPER_ADMIN"` para decidir acceso administrativo de app.
 * ADMIN_RRHH y los roles de supervisor NUNCA deben pasar este gate.
 */
export async function requireAppAdmin(): Promise<{ actorId: string; actorRole: AppRole }> {
  return requireCurrentRole("SUPER_ADMIN");
}
