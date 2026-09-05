import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-client";
import {
  STAGING_INVENTORY_SOURCES,
  type StagingInventoryTable,
  type StagingTableObservation,
} from "./inventory";

function safeErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9_]{1,32}$/i.test(value)) {
    return "QUERY_FAILED";
  }
  return value.toUpperCase();
}

async function countTable(
  table: StagingInventoryTable,
): Promise<StagingTableObservation> {
  const client = createAdminClient("staging-data-inventory");
  try {
    const { count, error } = await client
      .from(table)
      .select("id", { count: "exact", head: true });
    if (error || count === null) {
      return { table, count: null, errorCode: safeErrorCode(error?.code) };
    }
    return { table, count, errorCode: null };
  } catch {
    return { table, count: null, errorCode: "QUERY_FAILED" };
  }
}

export async function collectStagingDataInventory(): Promise<readonly StagingTableObservation[]> {
  return Promise.all(STAGING_INVENTORY_SOURCES.map((source) => countTable(source.table)));
}
