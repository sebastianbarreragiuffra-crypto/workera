const fullSha = /^[0-9a-f]{40}$/i;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const approvalPhrase = "staging-deployed";

const accountVariables = [
  "HOSTED_RRHH_EMAIL", "HOSTED_RRHH_PASSWORD",
  "HOSTED_PRODUCTION_EMAIL", "HOSTED_PRODUCTION_PASSWORD",
  "HOSTED_INSTALLATION_EMAIL", "HOSTED_INSTALLATION_PASSWORD",
  "HOSTED_NO_ACCESS_EMAIL", "HOSTED_NO_ACCESS_PASSWORD",
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
export function validateHostedPreflight(env: Environment): HostedPreflight {
  if (required(env, "HOSTED_EXECUTION_APPROVED") !== approvalPhrase) {
    throw new Error(`Ejecución bloqueada: HOSTED_EXECUTION_APPROVED debe ser ${approvalPhrase}.`);
  }

  const candidateSha = required(env, "HOSTED_CANDIDATE_SHA");
  const deployedSha = required(env, "HOSTED_DEPLOYED_SHA");
  if (!fullSha.test(candidateSha)) throw new Error("HOSTED_CANDIDATE_SHA debe ser un SHA Git completo.");
  if (!fullSha.test(deployedSha)) throw new Error("HOSTED_DEPLOYED_SHA debe ser un SHA Git completo.");
  if (candidateSha.toLowerCase() !== deployedSha.toLowerCase()) {
    throw new Error("Ejecución bloqueada: el SHA desplegado no coincide con el candidato.");
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
  for (const name of fixtureIdVariables) {
    if (!uuid.test(required(env, name))) throw new Error(`${name} debe ser UUID.`);
  }
  const canaries = canaryVariables.map((name) => required(env, name));
  if (new Set(canaries).size !== canaries.length) throw new Error("Los canarios hospedados deben ser únicos.");

  return { baseUrl: parsed.origin, candidateSha: candidateSha.toLowerCase(), deployedSha: deployedSha.toLowerCase() };
}
