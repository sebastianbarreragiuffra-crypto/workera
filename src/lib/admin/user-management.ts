import "server-only";
import { createClient as createSessionClient } from "../supabase/server";
import { createAdminClient } from "../supabase/admin-client";
import type { Database } from "../supabase/database.types";

/**
 * Servicios de gestión de usuarios de la aplicación (Fase 5D, PASO 9/10 del
 * encargo). Backend server-only — sin UI ni Route Handler todavía; existe
 * para que un futuro panel SUPER_ADMIN pueda construirse sobre esto sin
 * rediseñar la autorización.
 *
 * Principio de autorización de este módulo: la SESIÓN REAL del llamador
 * (`createSessionClient()`, ligada a cookies, sujeta a RLS) decide qué está
 * permitido — nunca el cliente admin (`service_role`). El cliente admin solo
 * se usa para la única cosa que la sesión normal no puede hacer: llamar a la
 * API de administración de Supabase Auth para crear la cuenta humana. La
 * asignación de rol resultante SIEMPRE se escribe a través de la sesión
 * normal, para que pase por la misma RLS de `profiles` que ya bloquea
 * escalamiento de privilegios (incluida la protección de SUPER_ADMIN) — una
 * sola fuente de verdad de autorización, nunca duplicada aquí.
 */

export type AppRole = Database["public"]["Enums"]["app_role"];

export class UserManagementAuthorizationError extends Error {}

export interface AppUserSummary {
  id: string;
  displayName: string;
  role: AppRole | null;
  active: boolean;
  createdAt: string;
}

async function requireCurrentRole(...allowedRoles: AppRole[]): Promise<{ actorId: string; actorRole: AppRole }> {
  const session = await createSessionClient();
  const { data: authData, error: authError } = await session.auth.getClaims();
  const actorId = authData?.claims?.sub as string | undefined;

  if (authError || !actorId) {
    throw new UserManagementAuthorizationError("No hay sesión autenticada.");
  }

  const { data: profile, error: profileError } = await session
    .from("profiles")
    .select("role")
    .eq("id", actorId)
    .single();

  if (profileError || !profile?.role || !allowedRoles.includes(profile.role)) {
    throw new UserManagementAuthorizationError(
      `Esta operación requiere uno de estos roles: ${allowedRoles.join(", ")}.`
    );
  }

  return { actorId, actorRole: profile.role };
}

/** Lista los usuarios de la aplicación. Requiere SUPER_ADMIN o ADMIN_RRHH — la misma RLS de `profiles_select` ya lo garantiza; esta función solo formatea el resultado. */
export async function listAppUsers(): Promise<AppUserSummary[]> {
  await requireCurrentRole("SUPER_ADMIN", "ADMIN_RRHH");

  const session = await createSessionClient();
  const { data, error } = await session
    .from("profiles")
    .select("id, display_name, role, active, created_at")
    .order("created_at", { ascending: true });

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    displayName: row.display_name,
    role: row.role,
    active: row.active,
    createdAt: row.created_at,
  }));
}

export interface CreateAppUserInput {
  email: string;
  displayName: string;
  role: AppRole;
  /** Si se omite, Supabase Auth genera una invitación por correo en vez de fijar una contraseña temporal directamente. */
  temporaryPassword?: string;
}

/**
 * Crea una cuenta humana nueva (Supabase Auth, vía admin client) y le asigna
 * el rol solicitado. Requiere SUPER_ADMIN o ADMIN_RRHH — pero crear una
 * cuenta con role="SUPER_ADMIN" requiere ser SUPER_ADMIN explícitamente
 * (revalidado aquí como defensa en profundidad, además de que la RLS de
 * `profiles_update` de todas formas rechazaría el UPDATE de rol si un
 * ADMIN_RRHH lo intentara).
 */
export async function createAppUser(input: CreateAppUserInput): Promise<{ userId: string }> {
  const { actorRole } = await requireCurrentRole("SUPER_ADMIN", "ADMIN_RRHH");

  if (input.role === "SUPER_ADMIN" && actorRole !== "SUPER_ADMIN") {
    throw new UserManagementAuthorizationError(
      "Solo SUPER_ADMIN puede crear otra cuenta SUPER_ADMIN."
    );
  }

  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.createUser({
    email: input.email,
    password: input.temporaryPassword,
    email_confirm: Boolean(input.temporaryPassword),
    user_metadata: { display_name: input.displayName },
  });

  if (error || !data.user) {
    throw error ?? new Error("createUser no devolvió un usuario.");
  }

  // El trigger on_auth_user_created (Fase 3) ya creó la fila de profiles con
  // role=NULL. La asignación de rol pasa por la sesión normal, no por el
  // admin client, para quedar sujeta a la misma RLS de profiles_update.
  const session = await createSessionClient();
  const { error: updateError } = await session
    .from("profiles")
    .update({ role: input.role, display_name: input.displayName })
    .eq("id", data.user.id);

  if (updateError) throw updateError;

  return { userId: data.user.id };
}

/** Cambia el rol de un usuario existente. Sujeto en última instancia a la RLS de `profiles_update` (protección de SUPER_ADMIN incluida). */
export async function assignRole(targetUserId: string, role: AppRole): Promise<void> {
  await requireCurrentRole("SUPER_ADMIN", "ADMIN_RRHH");

  const session = await createSessionClient();
  const { error } = await session.from("profiles").update({ role }).eq("id", targetUserId);
  if (error) throw error;
}

/** Activa/desactiva el acceso de un usuario. Sujeto a la RLS de `profiles_update` (incluida la protección del último SUPER_ADMIN activo). */
export async function setUserActive(targetUserId: string, active: boolean): Promise<void> {
  await requireCurrentRole("SUPER_ADMIN", "ADMIN_RRHH");

  const session = await createSessionClient();
  const { error } = await session.from("profiles").update({ active }).eq("id", targetUserId);
  if (error) throw error;
}
