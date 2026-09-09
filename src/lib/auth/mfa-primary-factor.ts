/** Texto único visible para el factor TOTP en toda la aplicación. */
export const MFA_AUTHENTICATOR_LABEL = "CÓDIGO DE AUTENTICADOR";

interface TotpFactorLike {
  id: string;
  friendly_name?: string;
  created_at?: string;
}

function normalizedFriendlyName(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("es");
}

/**
 * Mantiene como principal el factor histórico llamado "Teléfono principal".
 * Para cuentas antiguas con otros nombres, usa el factor más antiguo de forma
 * determinista. Los demás factores quedan fuera del flujo de autenticación.
 */
export function selectPrimaryTotpFactor<T extends TotpFactorLike>(factors: readonly T[]): T | null {
  if (factors.length === 0) return null;

  const explicitlyPrimary = factors.find(
    (factor) => normalizedFriendlyName(factor.friendly_name) === "telefono principal",
  );
  if (explicitlyPrimary) return explicitlyPrimary;

  return [...factors].sort((left, right) => {
    const byCreation = (left.created_at ?? "").localeCompare(right.created_at ?? "");
    return byCreation !== 0 ? byCreation : left.id.localeCompare(right.id);
  })[0];
}
