/**
 * Tenant operacional al que están vinculadas hoy las credenciales Workera.
 *
 * MT-3B mantiene un único workspace laboral habilitado. La constante hace
 * explícita esa vinculación en los jobs; no es un DEFAULT de base de datos y
 * no habilita automáticamente a empresas que sigan en onboarding.
 */
export const WORKERA_COMPANY_ID = "0a4c0000-0000-0000-0000-000000000001";
