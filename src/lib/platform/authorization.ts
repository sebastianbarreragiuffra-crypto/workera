import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "../supabase/server";
import type { Database } from "../supabase/database.types";

export type PlatformRole = Database["public"]["Enums"]["platform_role"];

export interface PlatformSession {
  userId: string;
  role: PlatformRole;
  canManage: boolean;
}

export class PlatformAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformAuthorizationError";
  }
}

const PLATFORM_ROLES: readonly PlatformRole[] = ["OWNER", "ADMIN", "SUPPORT", "VIEWER"];
const PLATFORM_MANAGER_ROLES: readonly PlatformRole[] = ["OWNER", "ADMIN"];

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === "string" && PLATFORM_ROLES.includes(value as PlatformRole);
}

export function isPlatformManagerRole(role: PlatformRole): boolean {
  return PLATFORM_MANAGER_ROLES.includes(role);
}

/**
 * Variante inyectable para el DAL y las pruebas. El cliente recibido debe ser
 * siempre el cliente ligado a cookies de `supabase/server`; nunca un cliente
 * `service_role`. La consulta sigue sujeta a la policy RLS de
 * `platform_memberships`, que además comprueba que el profile esté activo.
 */
export async function getPlatformSessionFromClient(
  supabase: SupabaseClient<Database>
): Promise<PlatformSession | null> {
  const { data: authData, error: authError } = await supabase.auth.getClaims();
  const userId = authData?.claims?.sub;

  if (authError || typeof userId !== "string" || userId.length === 0) {
    return null;
  }

  const { data: membership, error: membershipError } = await supabase
    .from("platform_memberships")
    .select("user_id, role, active")
    .eq("user_id", userId)
    .eq("active", true)
    .maybeSingle();

  if (membershipError) {
    throw new PlatformAuthorizationError("No se pudo verificar el acceso al control plane.");
  }

  if (!membership || membership.user_id !== userId || !membership.active || !isPlatformRole(membership.role)) {
    return null;
  }

  return {
    userId,
    role: membership.role,
    canManage: isPlatformManagerRole(membership.role),
  };
}

/** Resuelve la sesión real y devuelve `null` si no pertenece al control plane. */
export async function getPlatformSession(): Promise<PlatformSession | null> {
  const supabase = await createClient();
  return getPlatformSessionFromClient(supabase);
}

export async function requirePlatformSessionFromClient(
  supabase: SupabaseClient<Database>
): Promise<PlatformSession> {
  const session = await getPlatformSessionFromClient(supabase);
  if (!session) {
    throw new PlatformAuthorizationError("Esta operación requiere acceso activo al control plane.");
  }
  return session;
}

/** Autoriza lectura del portafolio para OWNER, ADMIN, SUPPORT y VIEWER. */
export async function requirePlatformSession(): Promise<PlatformSession> {
  const supabase = await createClient();
  return requirePlatformSessionFromClient(supabase);
}

export function assertPlatformManager(session: PlatformSession): PlatformSession {
  if (!isPlatformManagerRole(session.role)) {
    throw new PlatformAuthorizationError("Esta operación requiere rol OWNER o ADMIN de plataforma.");
  }
  return session;
}

/** Autoriza mutaciones del control plane únicamente para OWNER y ADMIN. */
export async function requirePlatformManager(): Promise<PlatformSession> {
  return assertPlatformManager(await requirePlatformSession());
}
