import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpWorkeraClient } from "./http-client";
import {
  WorkeraAuthenticationError,
  WorkeraAuthorizationError,
  WorkeraRateLimitError,
  WorkeraServerError,
  WorkeraTimeoutError,
  WorkeraValidationError,
  WorkeraConfigurationError,
} from "./errors";

/**
 * Todas las credenciales usadas aquí son FICTICIAS DE TEST — nunca las
 * reales de .env.local. Ningún test de este archivo hace una llamada de red
 * real (fetch se reemplaza siempre por un mock local).
 */
const TEST_CONFIG = {
  baseUrl: "https://workera.example.test/apiClient/v1",
  apiUser: "test-user@example.test",
  apiKey: "TEST_FAKE_API_KEY_00000000000000",
  requestTimeoutMs: 200,
};

function withMockFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(headers ?? {}) },
  });
}

const VALID_PAYLOAD = {
  page: 1,
  totalPages: 1,
  pageResult: 2,
  totalResult: 2,
  data: [
    {
      employee: { code: "90000017" },
      attendanceDate: "2026-08-18T07:30:00",
      attendanceType: 0,
      attendanceStatus: "ACTIVO",
      origin: "Dispositivo biométrico",
      originCode: "RELOJ",
      deviceName: "RELOJ-01",
      checksum: "ABC123",
    },
    {
      employee: { code: "90000018" },
      attendanceDate: "2026-08-18T17:00:00",
      attendanceType: 1,
      attendanceStatus: "MODIFICADO",
      origin: "Sistema",
      originCode: "SISTEMA",
    },
  ],
};

test("200 con payload válido: valida, mapea, no colapsa a clock_in/clock_out", async () => {
  await withMockFetch(
    async () => jsonResponse(200, VALID_PAYLOAD),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      const result = await client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" });

      assert.equal(result.page, 1);
      assert.equal(result.totalPages, 1);
      assert.equal(result.pageResult, 2);
      assert.equal(result.totalResult, 2);
      assert.equal(result.events.length, 2);
      // Nunca clockIn/clockOut colapsado -- forma a nivel de evento.
      assert.ok(!("clockIn" in result.events[0]));
      assert.ok(!("clockOut" in result.events[0]));
    }
  );
});

test("headers de la request son API_USER / API_KEY, con los valores configurados", async () => {
  let capturedHeaders: Headers | undefined;
  await withMockFetch(
    async (_url, init) => {
      capturedHeaders = new Headers(init?.headers);
      return jsonResponse(200, VALID_PAYLOAD);
    },
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" });
    }
  );

  assert.ok(capturedHeaders, "fetch debió llamarse");
  assert.equal(capturedHeaders!.get("API_USER"), TEST_CONFIG.apiUser);
  assert.equal(capturedHeaders!.get("API_KEY"), TEST_CONFIG.apiKey);
});

test("query params: start/end/page se envían; branchOffice/department/employees/attTypes solo si se pasan", async () => {
  let capturedUrl: string | undefined;
  await withMockFetch(
    async (url) => {
      capturedUrl = url.toString();
      return jsonResponse(200, VALID_PAYLOAD);
    },
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" });
    }
  );

  const url = new URL(capturedUrl!);
  assert.equal(url.pathname.endsWith("/attendanceData"), true);
  assert.equal(url.searchParams.get("start"), "2026-08-18");
  assert.equal(url.searchParams.get("end"), "2026-08-18");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.has("branchOffice"), false);
  assert.equal(url.searchParams.has("department"), false);
  assert.equal(url.searchParams.has("employees"), false);
  assert.equal(url.searchParams.has("attTypes"), false);
});

test("401 -> WorkeraAuthenticationError", async () => {
  await withMockFetch(
    async () => jsonResponse(401, { result: "ERROR", messages: ["Credenciales inválidas"] }),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await assert.rejects(
        () => client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" }),
        WorkeraAuthenticationError
      );
    }
  );
});

test("403 -> WorkeraAuthorizationError", async () => {
  await withMockFetch(
    async () => jsonResponse(403, { result: "ERROR", messages: ["Sin permiso"] }),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await assert.rejects(
        () => client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" }),
        WorkeraAuthorizationError
      );
    }
  );
});

test("429 -> WorkeraRateLimitError, propaga Retry-After", async () => {
  await withMockFetch(
    async () => jsonResponse(429, { result: "ERROR", messages: ["Rate limit"] }, { "Retry-After": "5" }),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      try {
        await client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" });
        assert.fail("debió lanzar WorkeraRateLimitError");
      } catch (err) {
        assert.ok(err instanceof WorkeraRateLimitError);
        assert.equal(err.retryAfterMs, 5000);
      }
    }
  );
});

test("500 -> WorkeraServerError", async () => {
  await withMockFetch(
    async () => jsonResponse(500, { result: "ERROR", messages: ["Internal"] }),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      try {
        await client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" });
        assert.fail("debió lanzar WorkeraServerError");
      } catch (err) {
        assert.ok(err instanceof WorkeraServerError);
        assert.equal(err.statusCode, 500);
      }
    }
  );
});

test("timeout -> WorkeraTimeoutError", async () => {
  await withMockFetch(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    async () => {
      const client = new HttpWorkeraClient({ ...TEST_CONFIG, requestTimeoutMs: 20 });
      await assert.rejects(
        () => client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" }),
        WorkeraTimeoutError
      );
    }
  );
});

test("JSON inválido -> WorkeraValidationError", async () => {
  await withMockFetch(
    async () =>
      new Response("esto no es JSON{{{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await assert.rejects(
        () => client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" }),
        WorkeraValidationError
      );
    }
  );
});

test("payload que no cumple el schema -> WorkeraValidationError (nunca llega al mapper)", async () => {
  await withMockFetch(
    async () => jsonResponse(200, { page: 1, totalPages: 1, pageResult: 1, totalResult: 1, data: [{ employee: { code: "" }, attendanceType: 99, attendanceStatus: "ACTIVO", attendanceDate: "x" }] }),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await assert.rejects(
        () => client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" }),
        WorkeraValidationError
      );
    }
  );
});

test("attendanceType 0..5 se mapean a las 6 etiquetas documentadas", async () => {
  const labels = ["ENTRADA", "SALIDA", "SALIDA_EXTRAORDINARIA", "ENTRADA_EXTRAORDINARIA", "INICIO_DESCANSO", "TERMINO_DESCANSO"];
  const payload = {
    page: 1,
    totalPages: 1,
    pageResult: 6,
    totalResult: 6,
    data: labels.map((_label, i) => ({
      employee: { code: `EMP-${i}` },
      attendanceDate: "2026-08-18T08:00:00",
      attendanceType: i,
      attendanceStatus: "ACTIVO",
    })),
  };

  await withMockFetch(
    async () => jsonResponse(200, payload),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      const result = await client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" });
      assert.deepEqual(
        result.events.map((e) => e.attendanceTypeLabel),
        labels
      );
    }
  );
});

test("attendanceStatus desconocido se conserva como UNKNOWN_EXTERNAL_STATUS, con el valor original preservado", async () => {
  const payload = {
    page: 1,
    totalPages: 1,
    pageResult: 1,
    totalResult: 1,
    data: [
      {
        employee: { code: "EMP-1" },
        attendanceDate: "2026-08-18T08:00:00",
        attendanceType: 0,
        attendanceStatus: "ESTADO_NO_DOCUMENTADO",
      },
    ],
  };

  await withMockFetch(
    async () => jsonResponse(200, payload),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      const result = await client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" });
      assert.equal(result.events[0].attendanceStatus, "UNKNOWN_EXTERNAL_STATUS");
      assert.equal(result.events[0].externalAttendanceStatus, "ESTADO_NO_DOCUMENTADO");
    }
  );
});

test("metadata de paginación se propaga intacta (page/totalPages/pageResult/totalResult)", async () => {
  const payload = { ...VALID_PAYLOAD, page: 3, totalPages: 9, pageResult: 20, totalResult: 171 };
  await withMockFetch(
    async () => jsonResponse(200, payload),
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      const result = await client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18", page: 3 });
      assert.equal(result.page, 3);
      assert.equal(result.totalPages, 9);
      assert.equal(result.pageResult, 20);
      assert.equal(result.totalResult, 171);
    }
  );
});

test("PII redaction: el log estructurado nunca contiene API_USER/API_KEY/datos de empleado", async () => {
  const originalLog = console.log;
  const logCalls: string[] = [];
  console.log = (...args: unknown[]) => {
    logCalls.push(args.map(String).join(" "));
  };

  try {
    await withMockFetch(
      async () => jsonResponse(200, VALID_PAYLOAD),
      async () => {
        const client = new HttpWorkeraClient(TEST_CONFIG);
        await client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" });
      }
    );
  } finally {
    console.log = originalLog;
  }

  const allLogs = logCalls.join("\n");
  assert.ok(!allLogs.includes(TEST_CONFIG.apiKey), "el log no debe contener el API key");
  assert.ok(!allLogs.includes(TEST_CONFIG.apiUser), "el log no debe contener el API user");
  assert.ok(!allLogs.includes("90000017"), "el log no debe contener códigos de empleado");
});

test("getEmployees/getAttendance/getAbsences no implementados todavía (fuera de alcance Fase 5C) -> WorkeraConfigurationError", async () => {
  const client = new HttpWorkeraClient(TEST_CONFIG);
  await assert.rejects(() => client.getEmployees(), WorkeraConfigurationError);
  await assert.rejects(
    () => client.getAttendance({ range: { from: "2026-08-18", to: "2026-08-18" } }),
    WorkeraConfigurationError
  );
  await assert.rejects(
    () => client.getAbsences({ range: { from: "2026-08-18", to: "2026-08-18" } }),
    WorkeraConfigurationError
  );
});

test("fallo de red (no AbortError) -> WorkeraNetworkError", async () => {
  await withMockFetch(
    async () => {
      throw new Error("ECONNREFUSED");
    },
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await assert.rejects(() => client.getAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" }));
    }
  );
});

// -----------------------------------------------------------------------------
// getAllAttendanceEvents (Fase 6A, PASO 20: "no detenerse en page 1") --
// recorrido completo de paginación, no solo la lectura de una sola página.

function pageResponse(page: number, totalPages: number, code: string): Response {
  return jsonResponse(200, {
    page,
    totalPages,
    pageResult: 1,
    totalResult: totalPages,
    data: [
      {
        employee: { code },
        attendanceDate: `2026-08-18T0${page}:00:00`,
        attendanceType: 0,
        attendanceStatus: "ACTIVO",
      },
    ],
  });
}

test("getAllAttendanceEvents: recorre TODAS las páginas, no se detiene en page 1 (dataset real conocido: 2 páginas)", async () => {
  const requestedPages: number[] = [];
  await withMockFetch(
    async (input) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      const page = Number(url.searchParams.get("page"));
      requestedPages.push(page);
      return pageResponse(page, 2, `EMP-${page}`);
    },
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      const result = await client.getAllAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" });
      assert.equal(result.pagesFetched, 2);
      assert.equal(result.events.length, 2);
      assert.deepEqual(requestedPages, [1, 2]);
    }
  );
});

test("getAllAttendanceEvents: falla explícito a mitad de paginación (page 2 con error de servidor) propaga el error, no devuelve datos parciales silenciosos", async () => {
  await withMockFetch(
    async (input) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      const page = Number(url.searchParams.get("page"));
      if (page === 1) return pageResponse(1, 2, "EMP-1");
      return jsonResponse(500, { message: "internal error" });
    },
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await assert.rejects(
        () => client.getAllAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" }),
        WorkeraServerError
      );
    }
  );
});

test("getAllAttendanceEvents: protección de límite de páginas -- excede maxPages -> WorkeraValidationError, no loop infinito", async () => {
  await withMockFetch(
    async (input) => {
      const url = new URL(typeof input === "string" ? input : (input as Request).url);
      const page = Number(url.searchParams.get("page"));
      // totalPages siempre "muy alto" -- simula un servidor que nunca termina.
      return pageResponse(page, 1000, `EMP-${page}`);
    },
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await assert.rejects(
        () => client.getAllAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" }, { maxPages: 3 }),
        WorkeraValidationError
      );
    }
  );
});

test("getAllAttendanceEvents: el servidor devuelve un page distinto al solicitado -> WorkeraValidationError, protección contra desincronización", async () => {
  await withMockFetch(
    async () => pageResponse(99, 2, "EMP-99"), // siempre responde page=99, sin importar lo solicitado
    async () => {
      const client = new HttpWorkeraClient(TEST_CONFIG);
      await assert.rejects(
        () => client.getAllAttendanceEvents({ start: "2026-08-18", end: "2026-08-18" }),
        WorkeraValidationError
      );
    }
  );
});
