import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/lib/supabase/database.types";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../../../src/lib/shared/workforce-constants";

export const ARCOTEX_SHADOW_AUTHORIZED_EMPLOYEES = [
  {
    id: "e2e20000-0000-4000-8000-000000000001",
    externalWorkeraId: "SYNTHETIC-1",
  },
  {
    id: "e2e20000-0000-4000-8000-000000000002",
    externalWorkeraId: "SYNTHETIC-2",
  },
  {
    id: "e2e20000-0000-4000-8000-000000000003",
    externalWorkeraId: "SYNTHETIC-3",
  },
  {
    id: "e2e20000-0000-4000-8000-000000000004",
    externalWorkeraId: "SYNTHETIC-4",
  },
] as const;

export interface ArcotexAuthorizedEmployeeReference {
  readonly id: string;
  readonly externalWorkeraId: string;
}

export interface ArcotexAuthorizedEmployeeScope {
  readonly employeeIds: readonly string[];
  readonly employees: readonly ArcotexAuthorizedEmployeeReference[];
}

/**
 * Alcance sintético exclusivo del servidor `next dev` de Playwright. La
 * configuración de Next reemplaza esta frontera solo cuando el harness E2E
 * está habilitado; el build productivo conserva la validación cerrada de las
 * 45 fichas autorizadas.
 */
export async function resolveArcotexAuthorizedEmployeeScope(
  _supabase: SupabaseClient<Database>,
  companyId: string,
): Promise<ArcotexAuthorizedEmployeeScope | undefined> {
  if (companyId.trim() !== ARCOTEX_WORKFORCE_COMPANY_ID) return undefined;

  return {
    employeeIds: ARCOTEX_SHADOW_AUTHORIZED_EMPLOYEES.map((employee) => employee.id),
    employees: ARCOTEX_SHADOW_AUTHORIZED_EMPLOYEES.map((employee) => ({ ...employee })),
  };
}
