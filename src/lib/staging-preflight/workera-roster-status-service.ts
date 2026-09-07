import "server-only";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "../shared/workforce-constants";
import { createAdminClient } from "../supabase/admin-client";

const PAGE_SIZE = 1_000;
const MAX_PAGES = 100;

export interface ArcotexLocalRosterStatusRow {
  externalWorkeraId: string;
  source: string;
  active: boolean;
}

/**
 * Lectura privilegiada y acotada usada exclusivamente por el auditor local.
 * La empresa no es un parámetro: este proceso compara la cuenta Workera
 * heredada únicamente con el tenant laboral ARCOTEX. No retorna nombres/RUT.
 */
export async function collectArcotexLocalRosterStatusRows(): Promise<ArcotexLocalRosterStatusRow[]> {
  const database = createAdminClient("workera-roster-status-audit");
  const rows: ArcotexLocalRosterStatusRow[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await database
      .from("employees")
      .select("id, external_workera_id, source, active")
      .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
      .order("external_workera_id", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error || !data) throw new Error("No se pudo leer el padrón local para la auditoría.");
    rows.push(
      ...data.map((row) => ({
        externalWorkeraId: row.external_workera_id,
        source: row.source,
        active: row.active,
      })),
    );
    if (data.length < PAGE_SIZE) return rows;
  }

  throw new Error("El padrón local excede el límite seguro de la auditoría.");
}
