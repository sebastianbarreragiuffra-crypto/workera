import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  getActiveDiscountWorkbookDataset,
  getActiveDiscountWorkbookMeta,
  updateActiveDiscountWorkbook,
} from "./discount-workbook-storage";

/**
 * `updateActiveDiscountWorkbook`/`getActiveDiscountWorkbookDataset` son la
 * fuente compartida que reemplaza la lectura del filesystem local
 * (`DESCUENTO DE COLACIONES.xlsx`, gitignored, nunca viajaba con el
 * despliegue -- bloqueador real de Vercel). El parseo/interpretación de
 * negocio reutiliza EXACTAMENTE `parseProductionMealDiscountRows`
 * (`source-workbook.test.ts` ya la prueba a fondo) -- estos tests cubren
 * solo la parte nueva: de dónde vienen los bytes y el flujo seguro de
 * reemplazo (validar -> subir -> activar, nunca al revés).
 */

const VALID_ROWS: (string | number | null)[][] = [
  ["Nombre", "Fecha", "Monto"],
  ["ALVAREZ CRISTOBAL", "15/07/2026", 2400],
];

function buildWorkbookBytes(rows: (string | number | null)[][]): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Hoja1");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array;
}

function mockSupabase(opts: {
  activeRow?: { id: string; storage_path: string; original_filename: string; uploaded_at: string } | null;
  downloadBytes?: Uint8Array;
  downloadError?: { message: string } | null;
  uploadError?: { message: string } | null;
  rpcError?: { message: string } | null;
} = {}) {
  const calls: string[] = [];
  const rpcArgs: unknown[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = {
    from(table: string) {
      if (table !== "colaciones_discount_workbooks") throw new Error(`mockSupabase: tabla no soportada: ${table}`);
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => {
                  calls.push("select:colaciones_discount_workbooks");
                  return Promise.resolve({ data: opts.activeRow ?? null, error: null });
                },
              };
            },
          };
        },
      };
    },
    storage: {
      from(bucket: string) {
        return {
          upload(path: string, _bytes: Uint8Array) {
            calls.push(`storage.upload:${bucket}:${path}`);
            if (opts.uploadError) return Promise.resolve({ error: opts.uploadError });
            return Promise.resolve({ error: null });
          },
          download(path: string) {
            calls.push(`storage.download:${bucket}:${path}`);
            if (opts.downloadError) return Promise.resolve({ data: null, error: opts.downloadError });
            return Promise.resolve({ data: new Blob([Buffer.from(opts.downloadBytes ?? new Uint8Array())]), error: null });
          },
        };
      },
    },
    rpc(fnName: string, args: unknown) {
      calls.push(`rpc:${fnName}`);
      rpcArgs.push(args);
      if (opts.rpcError) return Promise.resolve({ error: opts.rpcError });
      return Promise.resolve({ error: null });
    },
  };

  return { client, calls, rpcArgs };
}

test("getActiveDiscountWorkbookDataset: sin fila activa -> null (nunca inventa un dataset vacío)", async () => {
  const { client } = mockSupabase({ activeRow: null });
  const result = await getActiveDiscountWorkbookDataset(client);
  assert.equal(result, null);
});

test("getActiveDiscountWorkbookMeta: sin fila activa -> null", async () => {
  const { client } = mockSupabase({ activeRow: null });
  const result = await getActiveDiscountWorkbookMeta(client);
  assert.equal(result, null);
});

test("getActiveDiscountWorkbookDataset: con fila activa, descarga de Storage y parsea con la MISMA lógica de negocio existente", async () => {
  const bytes = buildWorkbookBytes(VALID_ROWS);
  const { client, calls } = mockSupabase({
    activeRow: { id: "wb-1", storage_path: "wb-1/descuento.xlsx", original_filename: "DESCUENTO DE COLACIONES.xlsx", uploaded_at: "2026-08-01T10:00:00Z" },
    downloadBytes: bytes,
  });

  const result = await getActiveDiscountWorkbookDataset(client);
  assert.ok(result);
  assert.equal(result.meta.originalFilename, "DESCUENTO DE COLACIONES.xlsx");
  assert.equal(result.dataset.records.length, 1);
  assert.equal(result.dataset.records[0].workerName, "ALVAREZ CRISTOBAL");
  assert.ok(calls.includes("storage.download:colaciones-config-files:wb-1/descuento.xlsx"), "debe descargar exactamente el storage_path de la fila activa");
});

test("getActiveDiscountWorkbookDataset: si Storage falla, lanza un error real -- nunca finge que los datos existen", async () => {
  const { client } = mockSupabase({
    activeRow: { id: "wb-1", storage_path: "wb-1/descuento.xlsx", original_filename: "x.xlsx", uploaded_at: "2026-08-01T10:00:00Z" },
    downloadError: { message: "boom" },
  });
  await assert.rejects(() => getActiveDiscountWorkbookDataset(client), /No pudimos descargar/);
});

test("updateActiveDiscountWorkbook: archivo inválido -- nunca sube a Storage ni activa nada, el archivo activo actual queda intacto", async () => {
  const invalidBytes = buildWorkbookBytes([["Trabajador", "Día", "Valor"]]); // sin las columnas Nombre/Fecha/Monto
  const { client, calls } = mockSupabase();

  await assert.rejects(
    () => updateActiveDiscountWorkbook(client, { fileBytes: invalidBytes, originalFilename: "malo.xlsx", uploadedBy: "profile-1" }),
    /Nombre, Fecha y Monto/,
  );
  assert.deepEqual(calls, [], "un archivo inválido no debe llegar a subir nada a Storage ni llamar la función de activación");
});

test("updateActiveDiscountWorkbook: archivo válido -- sube a un objeto NUEVO y activa vía la función atómica, en ese orden", async () => {
  const validBytes = buildWorkbookBytes(VALID_ROWS);
  const { client, calls, rpcArgs } = mockSupabase();

  const result = await updateActiveDiscountWorkbook(client, { fileBytes: validBytes, originalFilename: "DESCUENTO DE COLACIONES.xlsx", uploadedBy: "profile-1" });

  assert.ok(result.id);
  const uploadCall = calls.find((c) => c.startsWith("storage.upload:"));
  const rpcCall = calls.find((c) => c.startsWith("rpc:"));
  assert.ok(uploadCall, "debe subir el archivo a Storage");
  assert.equal(rpcCall, "rpc:activate_colaciones_discount_workbook");
  assert.ok(calls.indexOf(uploadCall!) < calls.indexOf(rpcCall!), "debe subir el archivo ANTES de activar -- nunca al revés");

  const args = rpcArgs[0] as Record<string, unknown>;
  assert.equal(args.p_uploaded_by, "profile-1");
  assert.equal(args.p_original_filename, "DESCUENTO DE COLACIONES.xlsx");
  assert.equal(typeof args.p_checksum, "string");
  assert.ok((args.p_checksum as string).length > 0, "debe calcular un checksum real del contenido");
});

test("updateActiveDiscountWorkbook: si la subida a Storage falla, NUNCA llama a la función de activación -- el archivo activo anterior no se toca", async () => {
  const validBytes = buildWorkbookBytes(VALID_ROWS);
  const { client, calls } = mockSupabase({ uploadError: { message: "storage caído" } });

  await assert.rejects(
    () => updateActiveDiscountWorkbook(client, { fileBytes: validBytes, originalFilename: "x.xlsx", uploadedBy: "profile-1" }),
    /No pudimos subir/,
  );
  assert.ok(!calls.some((c) => c.startsWith("rpc:")), "una subida fallida nunca debe intentar activar nada");
});

test("updateActiveDiscountWorkbook: si la activación (RPC) falla, el error se propaga con un mensaje claro", async () => {
  const validBytes = buildWorkbookBytes(VALID_ROWS);
  const { client } = mockSupabase({ rpcError: { message: "no autorizado" } });

  await assert.rejects(
    () => updateActiveDiscountWorkbook(client, { fileBytes: validBytes, originalFilename: "x.xlsx", uploadedBy: "profile-1" }),
    /No pudimos activar el nuevo archivo/,
  );
});
