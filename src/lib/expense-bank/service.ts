import "server-only";

import { createAdminClient } from "@/lib/supabase/admin-client";
import type { Json } from "@/lib/supabase/database.types";

export interface ExpenseBankImportServiceResult {
  importId: string | null;
  errorCode: string | null;
  failed: boolean;
}

export interface ExpenseBankUploadClaimResult {
  errorCode: string | null;
  failed: boolean;
}

/** Descuenta cuota durable antes de leer o decodificar el cuerpo HTTP. */
export async function claimExpenseBankUploadWithServiceRole(input: {
  actorId: string;
  companyId: string;
  declaredBytes: number;
}): Promise<ExpenseBankUploadClaimResult> {
  const admin = createAdminClient("expense-bank-import");
  const { error } = await admin.rpc("claim_expense_bank_upload", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_declared_bytes: input.declaredBytes,
  });
  return { errorCode: error?.code ?? null, failed: Boolean(error) };
}

/**
 * Límite privilegiado para importar una cartola ya validada por la Server
 * Action. El RPC no está expuesto a `authenticated`, de modo que PostgREST no
 * decodifica payloads bancarios arbitrarios enviados directamente desde un
 * navegador. PostgreSQL vuelve a comprobar el actor y la empresa recibidos.
 */
export async function importExpenseBankStatementWithServiceRole(input: {
  actorId: string;
  companyId: string;
  sourceChannel: "WEB_CSV" | "BANK_API";
  rows: Json;
}): Promise<ExpenseBankImportServiceResult> {
  const admin = createAdminClient("expense-bank-import");
  const { data, error } = await admin.rpc("import_expense_bank_statement", {
    p_actor_id: input.actorId,
    p_company_id: input.companyId,
    p_source_channel: input.sourceChannel,
    p_rows: input.rows,
  });

  return {
    importId: typeof data === "string" ? data : null,
    errorCode: error?.code ?? null,
    failed: Boolean(error),
  };
}
