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
  /** Resultado de la autoridad SQL `session_requires_mfa`. */
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
