import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpWorkeraClient } from "./http-client";

/**
 * Contract test READ-ONLY contra la API REAL de Workera (Fase 5C). OFF por
 * defecto — solo corre si WORKERA_CONTRACT_TESTS=1, para que `npm run
 * test:workera` normal (CI incluido) nunca dependa de la disponibilidad de
 * Workera ni de credenciales reales.
 *
 * Reglas de esta prueba (irrenunciables):
 *   - Solo lectura: únicamente GET /attendanceData.
 *   - Solo página 1 (no recorre toda la empresa).
 *   - No persiste el payload real en ningún lado (ni disco ni Supabase).
 *   - No imprime PII (nombres, RUT, identificación, código de ficha real).
 *   - No escribe en Workera ni en Supabase.
 *
 * Uso: WORKERA_CONTRACT_TESTS=1 npm run test:workera
 * (requiere WORKERA_BASE_URL/WORKERA_API_USER/WORKERA_API_KEY reales en
 * .env.local — este archivo los carga con process.loadEnvFile, nunca los
 * imprime).
 */

const CONTRACT_TESTS_ENABLED = process.env.WORKERA_CONTRACT_TESTS === "1";

if (CONTRACT_TESTS_ENABLED) {
  try {
    // Node 21+. No falla si .env.local no existe (ej. en CI) -- las
    // aserciones de abajo fallarán igual con un mensaje claro por
    // configuración faltante, no por esta carga.
    process.loadEnvFile?.(".env.local");
  } catch {
    // .env.local no encontrado -- se deja que la validación de configuración
    // de abajo reporte el problema con un mensaje claro.
  }
}

function todayInSantiago(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA formats as yyyy-MM-dd directly.
  return formatter.format(new Date());
}

test(
  "CONTRACT (real Workera): GET /attendanceData de hoy, solo lectura, página 1, sin PII",
  { skip: !CONTRACT_TESTS_ENABLED && "WORKERA_CONTRACT_TESTS!=1 -- opt-in, no corre por defecto" },
  async () => {
    const baseUrl = process.env.WORKERA_BASE_URL;
    const apiUser = process.env.WORKERA_API_USER;
    const apiKey = process.env.WORKERA_API_KEY;

    assert.ok(baseUrl, "WORKERA_BASE_URL debe estar configurado para el contract test");
    assert.ok(apiUser, "WORKERA_API_USER debe estar configurado para el contract test");
    assert.ok(apiKey, "WORKERA_API_KEY debe estar configurado para el contract test");

    const client = new HttpWorkeraClient({
      baseUrl: baseUrl!,
      apiUser: apiUser!,
      apiKey: apiKey!,
      requestTimeoutMs: 15_000,
    });

    const today = todayInSantiago();
    const result = await client.getAttendanceEvents({ start: today, end: today, page: 1 });

    // Solo metadata estructural -- nunca el payload ni datos de empleado.
    console.log(
      "[contract-test] TODAY_ATTENDANCE_READ metadata:",
      JSON.stringify({
        date: today,
        page: result.page,
        totalPages: result.totalPages,
        pageResult: result.pageResult,
        totalResult: result.totalResult,
        recordsReceived: result.events.length,
      })
    );

    assert.equal(result.page, 1);
    assert.ok(result.totalPages >= 1);
    assert.ok(Array.isArray(result.events));
    assert.equal(result.events.length, result.pageResult);

    // Forma normalizada correcta para cada evento, sin exponer identidad.
    for (const event of result.events) {
      assert.equal(typeof event.employeeExternalId, "string");
      assert.ok(event.employeeExternalId.length > 0);
      assert.equal(typeof event.attendanceTimestampRaw, "string");
      assert.ok(event.attendanceTypeCode >= 0 && event.attendanceTypeCode <= 5);
      assert.ok(
        [
          "ACTIVO",
          "INACTIVO",
          "MODIFICADO",
          "UNKNOWN_EXTERNAL_STATUS",
        ].includes(event.attendanceStatus)
      );
    }
  }
);
