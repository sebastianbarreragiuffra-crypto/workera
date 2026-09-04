import type { Database } from "../supabase/database.types";

/**
 * Regla de segundo factor del lado de la aplicación.
 *
 * Es un ESPEJO de `public.account_requires_mfa()`, no la autoridad. La
 * autoridad es la base: el gate del middleware consulta `session_requires_mfa`
 * y los RPC sensibles llaman a `enforce_mfa_for_privileged()`. Este módulo
 * existe para que la interfaz pueda explicar y anticipar la misma regla sin
 * una consulta extra, y para poder probarla como función pura.
 *
 * Si la regla cambia, cambia primero en la migración y después acá. Las dos
 * copias tienen que decir lo mismo; la prueba de esta función y la prueba
 * pgTAP 049 describen el mismo conjunto a propósito.
 */

export type AppRole = Database["public"]["Enums"]["app_role"];
export type PlatformRole = Database["public"]["Enums"]["platform_role"];

/** Roles del workspace ARCOTEX cuyo compromiso causa el mayor daño. */
const WORKSPACE_MFA_ROLES: readonly AppRole[] = ["SUPER_ADMIN", "ADMIN_RRHH"];

/** Roles del control plane que administran la cartera completa de clientes. */
const PLATFORM_MFA_ROLES: readonly PlatformRole[] = ["OWNER", "ADMIN"];

export interface MfaAccount {
  /** `profiles.role` y `profiles.active` de la cuenta. */
  profile: { role: AppRole | null; active: boolean } | null;
  /** Membresía de plataforma de la cuenta, si tiene alguna. */
  platformMembership: { role: PlatformRole; active: boolean } | null;
}

/**
 * ¿Esta cuenta exige segundo factor? Una cuenta desactivada nunca lo exige:
 * ya no puede entrar por otras razones, y tratarla como privilegiada solo
 * produciría redirecciones a una pantalla que no le sirve.
 *
 * Hoy los `SUPERVISOR_*` quedan fuera, igual que en la migración. Ampliar el
 * alcance es agregar el rol a una de las dos listas de arriba y a
 * `account_requires_mfa`, sin tocar ninguna pantalla.
 */
export function profileRequiresMfa(account: MfaAccount): boolean {
  const { profile, platformMembership } = account;

  const byWorkspaceRole =
    profile !== null &&
    profile.active &&
    profile.role !== null &&
    WORKSPACE_MFA_ROLES.includes(profile.role);

  const byPlatformRole =
    profile !== null &&
    profile.active &&
    platformMembership !== null &&
    platformMembership.active &&
    PLATFORM_MFA_ROLES.includes(platformMembership.role);

  return byWorkspaceRole || byPlatformRole;
}

/**
 * Lo único que una cuenta privilegiada en `aal1` puede alcanzar mientras el
 * enforcement esté activo. Todo lo demás la devuelve a `/seguridad/mfa`.
 *
 * `/login/mfa` está en la lista porque es la pantalla del desafío de la
 * sección 6.2 del diseño: se llega a ella con la sesión ya creada y todavía en
 * `aal1`, que es exactamente la condición que el gate bloquea. Sin esta
 * entrada, el redirect que hace `login/actions.ts` nunca llegaría a destino.
 *
 * NO hay entrada `/logout`: cerrar sesión no es una ruta sino la Server Action
 * `logout` de `src/app/login/actions.ts`, y una Server Action se postea a la
 * ruta que la renderiza. Listar una ruta inexistente hacía creer que la salida
 * estaba resuelta cuando en realidad una sesión privilegiada en aal1 quedaba
 * sin ninguna forma de cerrar sesión: el gate la sacaba de toda página que
 * mostrara el botón. La salida real son los botones de las dos pantallas MFA,
 * que postean a `/seguridad/mfa` y `/login/mfa`, ambas ya permitidas acá.
 *
 * Los assets no aparecen acá porque no llegan al gate: el matcher de
 * `src/proxy.ts` ya los excluye del middleware.
 */
export const MFA_ALLOWED_PATHS: readonly string[] = [
  "/seguridad/mfa",
  "/login",
  "/login/mfa",
  "/auth/callback",
  "/auth/confirm",
];

const MFA_ALLOWED_PATH_SET = new Set<string>(MFA_ALLOWED_PATHS);

/**
 * Coincidencia exacta y no por prefijo: `/login` no debe habilitar
 * `/login-de-mentira`, y una ruta nueva bajo `/seguridad/` no debe quedar
 * abierta por parecerse a la pantalla de inscripción. Igual que
 * `isPublicPath`, agregar una ruta acá es una decisión explícita.
 */
export function isMfaAllowedPath(pathname: string): boolean {
  return MFA_ALLOWED_PATH_SET.has(pathname);
}

/**
 * A dónde va una sesión recién creada por contraseña (sección 6.2 del diseño).
 *
 * Las tres salidas son distintas a propósito:
 *   - `/login/mfa`: la cuenta YA tiene un factor verificado y solo le falta
 *     subir de nivel. Es un desafío, no una inscripción.
 *   - `/seguridad/mfa`: la cuenta debe tener segundo factor y todavía no
 *     inscribió ninguno. No hay nada que desafiar.
 *   - `/`: no hay nada pendiente.
 *
 * `nextLevel === "aal2"` es lo que informa Supabase cuando la cuenta tiene al
 * menos un factor verificado; por eso alcanza para distinguir los dos primeros
 * casos sin una consulta extra.
 */
export type PostLoginDestination = "/login/mfa" | "/seguridad/mfa" | "/";

export interface PostLoginInput {
  currentLevel: string | null;
  nextLevel: string | null;
  /** Espejo de `account_requires_mfa` para esta cuenta. */
  requiresMfa: boolean;
  hasVerifiedFactor: boolean;
}

export function postLoginDestination(input: PostLoginInput): PostLoginDestination {
  if (input.nextLevel === "aal2" && input.currentLevel !== "aal2") {
    return "/login/mfa";
  }
  if (input.requiresMfa && !input.hasVerifiedFactor) {
    return "/seguridad/mfa";
  }
  return "/";
}
