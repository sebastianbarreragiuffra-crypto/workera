import "server-only";
import { createClient as createSessionClient } from "../supabase/server";
import { createAdminClient } from "../supabase/admin-client";
import { AuthorizationError } from "../supabase/authorize";
import type { Database } from "../supabase/database.types";
import { getPlatformSessionFromClient } from "../platform/authorization";
import { getVerifiedCurrentAal } from "../auth/mfa-account";

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
 *
 * `requireCurrentRole` vive en src/lib/supabase/authorize.ts (extraído en
 * Fase 6B) para que src/lib/sync/scheduler.ts (rerun manual) reutilice el
 * mismo criterio en vez de duplicarlo.
 */

export type AppRole = Database["public"]["Enums"]["app_role"];

/** Alias retrocompatible -- el error real ahora vive en supabase/authorize.ts. */
export const UserManagementAuthorizationError = AuthorizationError;

export interface AppUserSummary {
  id: string;
  displayName: string;
  role: AppRole | null;
  active: boolean;
  createdAt: string;
}

async function requireGlobalIdentityOwner() {
  // Una identidad global solo puede administrarla el OWNER real de la
  // plataforma después de verificar su segundo factor. No se exige un rol
  // Arcotex: un futuro OWNER legítimo puede no pertenecer a ese cliente.
  const session = await createSessionClient();
  const [platform, aal] = await Promise.all([
    getPlatformSessionFromClient(session),
    getVerifiedCurrentAal(session),
  ]);
  if (platform?.role !== "OWNER" || aal !== "aal2") {
    throw new AuthorizationError("Esta operación requiere OWNER de plataforma con MFA verificado.");
  }
  return session;
}

/**
 * Lista los usuarios de la aplicación. Requiere APP_ADMIN (SUPER_ADMIN) --
 * restringido en Fase 8D (antes permitía también ADMIN_RRHH; el encargo de
 * Fase 8D es explícito: "user administration" es una capacidad exclusiva de
 * APP_ADMIN, ADMIN_RRHH no la hereda).
 */
export async function listAppUsers(): Promise<AppUserSummary[]> {
  const session = await requireGlobalIdentityOwner();
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
 * Compatibilidad exclusiva del workspace laboral Arcotex: crea una identidad
 * global y le asigna un app_role legacy. Las altas multiempresa normales usan
 * company_invitations; no se debe reutilizar este servicio para otro tenant.
 */
export async function createAppUser(input: CreateAppUserInput): Promise<{ userId: string }> {
  const session = await requireGlobalIdentityOwner();

  const admin = createAdminClient("auth-user-provisioning");
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
  const { data: updatedProfile, error: updateError } = await session
    .from("profiles")
    .update({ role: input.role, display_name: input.displayName })
    .eq("id", data.user.id)
    .select("id")
    .single();

  if (updateError || !updatedProfile) {
    const { error: cleanupError } = await admin.auth.admin.deleteUser(data.user.id);
    if (cleanupError) {
      console.error("[auth] no se pudo revertir una cuenta sin rol", {
        event: "auth_user_provisioning_rollback_failed",
      });
    }
    throw updateError ?? new Error("No se confirmó la asignación de identidad global.");
  }

  return { userId: data.user.id };
}

/**
 * Cambia el rol de un usuario existente. Requiere APP_ADMIN (SUPER_ADMIN) --
 * restringido en Fase 8D (antes permitía también ADMIN_RRHH). Sujeto en
 * última instancia a la RLS de `profiles_update` (protección de SUPER_ADMIN
 * incluida) como defensa en profundidad, no como único gate.
 */
export async function assignRole(targetUserId: string, role: AppRole): Promise<void> {
  const session = await requireGlobalIdentityOwner();
  const { data, error } = await session.from("profiles").update({ role }).eq("id", targetUserId).select("id").single();
  if (error || !data) throw error ?? new Error("No se confirmó el cambio de rol.");
}

/**
 * Activa/desactiva el acceso de un usuario. Requiere APP_ADMIN (SUPER_ADMIN)
 * -- restringido en Fase 8D (antes permitía también ADMIN_RRHH). Sujeto a
 * la RLS de `profiles_update` (incluida la protección del último SUPER_ADMIN
 * activo) como defensa en profundidad.
 */
export async function setUserActive(targetUserId: string, active: boolean): Promise<void> {
  const session = await requireGlobalIdentityOwner();
  const { data, error } = await session.from("profiles").update({ active }).eq("id", targetUserId).select("id").single();
  if (error || !data) throw error ?? new Error("No se confirmó el cambio de estado.");
}
