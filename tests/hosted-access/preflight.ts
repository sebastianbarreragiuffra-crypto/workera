const fullSha = /^[0-9a-f]{40}$/i;
const sha256 = /^[0-9a-f]{64}$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const base32Secret = /^[A-Z2-7]+=*$/i;
const approvalPhrase = "staging-deployed";
const operatorAal2Phrase = "personal-aal2";

const accountVariables = [
  "HOSTED_RRHH_EMAIL", "HOSTED_RRHH_PASSWORD",
  "HOSTED_PRODUCTION_EMAIL", "HOSTED_PRODUCTION_PASSWORD",
  "HOSTED_INSTALLATION_EMAIL", "HOSTED_INSTALLATION_PASSWORD",
  "HOSTED_NO_ACCESS_EMAIL", "HOSTED_NO_ACCESS_PASSWORD",
] as const;

const totpVariables = [
  "HOSTED_RRHH_TOTP_SECRET",
  "HOSTED_PRODUCTION_TOTP_SECRET",
  "HOSTED_INSTALLATION_TOTP_SECRET",
  "HOSTED_NO_ACCESS_TOTP_SECRET",
] as const;

const fixtureIdVariables = [
  "HOSTED_RRHH_ALLOWED_EMPLOYEE_ID",
  "HOSTED_PRODUCTION_ALLOWED_EMPLOYEE_ID",
  "HOSTED_INSTALLATION_ALLOWED_EMPLOYEE_ID",
  "HOSTED_PRODUCTION_DENIED_AREA_EMPLOYEE_ID",
  "HOSTED_INSTALLATION_DENIED_AREA_EMPLOYEE_ID",
  "HOSTED_OTHER_COMPANY_EMPLOYEE_ID",
  "HOSTED_OUTSIDE_ROSTER_EMPLOYEE_ID",
] as const;

const canaryVariables = [
  "HOSTED_FORBIDDEN_CANARY_AREA",
  "HOSTED_FORBIDDEN_CANARY_COMPANY",
  "HOSTED_FORBIDDEN_CANARY_ROSTER",
] as const;

export type HostedPreflight = {
  baseUrl: string;
  candidateSha: string;
  deployedSha: string;
  gateSha: string;
  authorizationDigest: string;
  deploymentEvidenceDigest: string;
  windowStartUtc: string;
  windowEndUtc: string;
};

type Environment = Readonly<Record<string, string | undefined>>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Falta ${name}.`);
  return value;
}

/**
 * Gate local y sin red. El operador obtiene HOSTED_DEPLOYED_SHA desde el
 * proveedor de despliegue, no desde la aplicación que se está probando.
 */
function requiredUtcInstant(env: Environment, name: string): { value: string; epochMs: number } {
  const value = required(env, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new Error(`${name} debe usar UTC en formato YYYY-MM-DDTHH:mm:ssZ.`);
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) throw new Error(`${name} debe ser una fecha UTC válida.`);
  return { value, epochMs };
}

export function validateHostedPreflight(env: Environment, now = new Date()): HostedPreflight {
  if (required(env, "HOSTED_EXECUTION_APPROVED") !== approvalPhrase) {
    throw new Error(`Ejecución bloqueada: HOSTED_EXECUTION_APPROVED debe ser ${approvalPhrase}.`);
  }
  if (required(env, "HOSTED_OPERATOR_AAL2_APPROVED") !== operatorAal2Phrase) {
    throw new Error(`Ejecución bloqueada: HOSTED_OPERATOR_AAL2_APPROVED debe ser ${operatorAal2Phrase}.`);
  }

  const windowStart = requiredUtcInstant(env, "HOSTED_WINDOW_START_UTC");
  const windowEnd = requiredUtcInstant(env, "HOSTED_WINDOW_END_UTC");
  if (windowStart.epochMs >= windowEnd.epochMs) {
    throw new Error("Ejecución bloqueada: la ventana autorizada no tiene un intervalo válido.");
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || nowMs < windowStart.epochMs || nowMs > windowEnd.epochMs) {
    throw new Error("Ejecución bloqueada: la hora actual está fuera de la ventana autorizada.");
  }

  const candidateSha = required(env, "HOSTED_CANDIDATE_SHA");
  const deployedSha = required(env, "HOSTED_DEPLOYED_SHA");
  const gateSha = required(env, "HOSTED_GATE_SHA");
  if (!fullSha.test(candidateSha)) throw new Error("HOSTED_CANDIDATE_SHA debe ser un SHA Git completo.");
  if (!fullSha.test(deployedSha)) throw new Error("HOSTED_DEPLOYED_SHA debe ser un SHA Git completo.");
  if (!fullSha.test(gateSha)) throw new Error("HOSTED_GATE_SHA debe ser un SHA Git completo.");
  if (new Set([candidateSha.toLowerCase(), deployedSha.toLowerCase(), gateSha.toLowerCase()]).size !== 1) {
    throw new Error("Ejecución bloqueada: candidato, despliegue y gate deben usar el mismo SHA.");
  }
  const authorizationDigest = required(env, "HOSTED_AUTHORIZATION_DIGEST");
  const deploymentEvidenceDigest = required(env, "HOSTED_DEPLOYMENT_EVIDENCE_DIGEST");
  if (!sha256.test(authorizationDigest)) throw new Error("HOSTED_AUTHORIZATION_DIGEST debe ser SHA-256 hexadecimal.");
  if (!sha256.test(deploymentEvidenceDigest)) {
    throw new Error("HOSTED_DEPLOYMENT_EVIDENCE_DIGEST debe ser SHA-256 hexadecimal.");
  }

  const baseUrl = required(env, "HOSTED_BASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("HOSTED_BASE_URL debe ser un origen HTTPS válido de staging.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("HOSTED_BASE_URL debe ser un origen HTTPS sin credenciales, ruta, query ni fragmento.");
  }

  for (const name of accountVariables) required(env, name);
  for (const name of totpVariables) {
    const secret = required(env, name).replace(/\s|=/g, "");
    if (secret.length < 16 || !base32Secret.test(secret)) throw new Error(`${name} debe ser un secreto TOTP Base32 válido.`);
  }
  for (const name of fixtureIdVariables) {
    if (!uuid.test(required(env, name))) throw new Error(`${name} debe ser UUID.`);
  }
  const canaries = canaryVariables.map((name) => required(env, name));
  if (new Set(canaries).size !== canaries.length) throw new Error("Los canarios hospedados deben ser únicos.");

  return {
    baseUrl: parsed.origin,
    candidateSha: candidateSha.toLowerCase(),
    deployedSha: deployedSha.toLowerCase(),
    gateSha: gateSha.toLowerCase(),
    authorizationDigest: authorizationDigest.toLowerCase(),
    deploymentEvidenceDigest: deploymentEvidenceDigest.toLowerCase(),
    windowStartUtc: windowStart.value,
    windowEndUtc: windowEnd.value,
  };
}
