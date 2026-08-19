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
