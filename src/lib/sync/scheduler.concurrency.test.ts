import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../supabase/database.types";

/**
 * PRUEBA REAL de concurrencia (Fase 6B, PASO 50: "Obligatorio. Dos syncs
 * simultáneos mismo día... No duplicates"). A diferencia del resto de
 * `src/lib/sync/**\/*.test.ts` (100% mockeado, sin depender de Supabase
 * local levantado -- invariante que este archivo preserva para el resto de
 * la suite), esta prueba golpea la base de datos LOCAL real con dos
 * requests PostgREST verdaderamente concurrentes (dos conexiones
 * independientes, no dos statements secuenciales en una misma transacción
 * como puede probar pgTAP) para demostrar que el índice único parcial
 * `sync_runs_no_concurrent_running_key` sigue siendo la garantía real bajo
 * concurrencia de procesos, no solo bajo un test de una sola sesión.
 *
 * Opt-in explícito (mismo patrón que WORKERA_CONTRACT_TESTS de Fase 5C):
 * requiere `SYNC_CONCURRENCY_REAL_TEST=1` Y Supabase local corriendo.
 * Si cualquiera de las dos condiciones falta, el test se salta con un
 * motivo explícito -- nunca falla silenciosamente ni bloquea `npm run
 * test:sync` en un entorno sin Docker.
 */

const REAL_TEST_ENABLED = process.env.SYNC_CONCURRENCY_REAL_TEST === "1";

// Credenciales demo ESTÁNDAR de Supabase CLI local -- fijas, públicamente
// documentadas, no secretas (mismo criterio ya usado en este proyecto para
// scripts de verificación local). Nunca apuntan a un ambiente real.
const LOCAL_URL = "http://127.0.0.1:54321";
const LOCAL_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

test(
  "CONCURRENCIA REAL: dos INSERT RUNNING verdaderamente simultáneos para el mismo rango -- exactamente uno gana, cero duplicados",
  { skip: !REAL_TEST_ENABLED && "SYNC_CONCURRENCY_REAL_TEST != 1 -- prueba real opt-in, no corre por default" },
  async () => {
    const admin = createClient<Database>(LOCAL_URL, LOCAL_SERVICE_ROLE_KEY);

    // Fecha sintética e improbable de colisionar con datos reales de otra
    // corrida de este mismo test o de trabajo manual previo en la sesión.
    const targetDate = "2099-01-01";

    // Limpieza defensiva por si una corrida anterior de este test quedó a
    // medias (no debería, pero un test real no debe asumir un estado
    // perfectamente limpio de antemano).
    await admin.from("sync_runs").delete().eq("target_period_start", targetDate);

    try {
      const attemptInsert = () =>
        admin
          .from("sync_runs")
          .insert({ status: "RUNNING", target_period_start: targetDate, target_period_end: targetDate, triggered_by: "CRON" })
          .select("id")
          .single();

      // Dos requests PostgREST disparados en paralelo de verdad -- no hay
      // ningún await entre ellos que los serialice del lado del cliente.
      const [first, second] = await Promise.all([attemptInsert(), attemptInsert()]);

      const outcomes = [first, second];
      const succeeded = outcomes.filter((o) => !o.error && o.data);
      const rejected = outcomes.filter((o) => o.error);

      assert.equal(succeeded.length, 1, "exactamente uno de los dos INSERT concurrentes debe tener éxito");
      assert.equal(rejected.length, 1, "el otro debe fallar (rechazado por el índice único parcial)");
      assert.equal(rejected[0].error?.code, "23505", "el rechazo debe ser específicamente el conflicto de unicidad esperado, no otro error");

      const { data: rows, error: countError } = await admin
        .from("sync_runs")
        .select("id, status")
        .eq("target_period_start", targetDate);

      assert.equal(countError, null);
      assert.equal(rows?.length, 1, "cero duplicados: solo debe existir UNA fila para este rango pese a los dos intentos concurrentes");
      assert.equal(rows?.[0]?.status, "RUNNING");
    } finally {
      await admin.from("sync_runs").delete().eq("target_period_start", targetDate);
    }
  }
);
