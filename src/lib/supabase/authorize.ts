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
    .select("role, active")
    .eq("id", actorId)
    .single();

  if (profileError || !profile?.active || !profile.role || !allowedRoles.includes(profile.role)) {
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

/**
 * Gate único para aprobar/rechazar licencias médicas (encargo Licencias --
 * flujo de dos etapas). Deliberadamente NO usa rol (`ADMIN_RRHH`) ni
 * `requireAppAdmin()` -- la autoridad de aprobación está restringida a UNA
 * cuenta específica (marcada `profiles.medical_license_approver`, ver
 * migración `20260825100000_medical_license_approval.sql`), nunca a "todo
 * ADMIN_RRHH" ni a SUPER_ADMIN por bypass. RLS/las funciones
 * `approve_medical_license`/`reject_medical_license` vuelven a exigir esto
 * mismo en la base de datos -- este gate es una segunda capa con mensaje
 * claro, no la única barrera (ver docs/SECURITY_PHASE3.md).
 */
export async function requireMedicalLicenseApprover(): Promise<{ actorId: string; actorRole: AppRole }> {
  const session = await createSessionClient();
  const { data: authData, error: authError } = await session.auth.getClaims();
  const actorId = authData?.claims?.sub as string | undefined;

  if (authError || !actorId) {
    throw new AuthorizationError("No hay sesión autenticada.");
  }

  const { data: profile, error: profileError } = await session
    .from("profiles")
    .select("role, active, medical_license_approver")
    .eq("id", actorId)
    .single();

  if (profileError || !profile?.active || !profile.role || !profile.medical_license_approver) {
    throw new AuthorizationError("Esta operación requiere ser la cuenta autorizada para aprobar licencias médicas.");
  }

  return { actorId, actorRole: profile.role };
}

/** Versión pura/síncrona del mismo criterio, para gatear UI (mostrar/ocultar botones) a partir de un profile ya cargado -- nunca la única barrera, ver `requireMedicalLicenseApprover`. */
export function canApproveMedicalLicense(profile: { active: boolean; medical_license_approver: boolean } | null | undefined): boolean {
  return profile?.active === true && profile.medical_license_approver === true;
}

/**
 * Versión pura/síncrona de "SUPER_ADMIN o ADMIN_RRHH" -- el mismo criterio
 * que RLS ya centraliza en `is_privileged_admin()` (Postgres), pero para
 * decidir en código de aplicación (páginas/Server Actions que ya tienen un
 * `profile` en mano vía `getCurrentProfile()` y solo necesitan la
 * comparación, sin volver a consultar la sesión). Antes cada página/acción
 * repetía `role !== "SUPER_ADMIN" && role !== "ADMIN_RRHH"` por su cuenta;
 * RLS sigue siendo el enforcement real -- esto es la segunda capa con
 * mensaje claro, igual que el resto de gates de este archivo.
 */
export function isPrivilegedAdmin(role: AppRole | null | undefined): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN_RRHH";
}
