import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadSupportingDocument, getSignedDocumentUrl, MAX_SUPPORTING_DOCUMENT_SIZE_BYTES } from "./documents";


/** `employees.id` es una columna uuid: el fixture debe parecerse al dato real. */
const EMPLOYEE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
function mockSupabase({ insertedRows, docRow, signedUrlOk = true }: { insertedRows: Record<string, unknown>[]; docRow?: { storage_path: string } | null; signedUrlOk?: boolean }) {
  return {
    storage: {
      from() {
        return {
          upload: () => Promise.resolve({ data: { path: "x" }, error: null }),
          createSignedUrl: () =>
            signedUrlOk ? Promise.resolve({ data: { signedUrl: "https://example.test/signed" }, error: null }) : Promise.resolve({ data: null, error: { message: "no access" } }),
        };
      },
    },
    from(table: string) {
      if (table === "supporting_documents") {
        return {
          insert(row: Record<string, unknown>) {
            insertedRows.push(row);
            // Real behavior being regression-tested: this table's SELECT
            // policy is exclusive to is_privileged_admin() (grants_lockdown
            // migration), so `INSERT ... RETURNING` fails for a supervisor
            // even though the WITH CHECK on the insert itself passed. A mock
            // that resolves `.select()` as an error models that faithfully --
            // uploadSupportingDocument must never call `.select()` here.
            return {
              select() {
                throw new Error("uploadSupportingDocument must not call .select() after insert -- see grants_lockdown RLS RETURNING bug");
              },
              then(onResolve: (r: { data: null; error: null }) => void) {
                onResolve({ data: null, error: null });
              },
            };
          },
          select() {
            return {
              eq() {
                return {
                  single: () => Promise.resolve(docRow ? { data: docRow, error: null } : { data: null, error: { message: "not found" } }),
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("uploadSupportingDocument: nunca llama .select() tras el insert -- una fila RETURNING requeriria pasar la policy de SELECT (solo admins), rompiendo siempre para un supervisor", async () => {
  const insertedRows: Record<string, unknown>[] = [];
  const supabase = mockSupabase({ insertedRows });

  const result = await uploadSupportingDocument(supabase, {
    employeeId: EMPLOYEE_ID,
    documentType: "OTHER",
    originalFilename: "a.pdf",
    mimeType: "application/pdf",
    fileBytes: new Uint8Array([1, 2, 3]),
  });

  assert.ok(result.documentId, "debe devolver un documentId generado en el cliente");
  assert.equal(insertedRows.length, 1);
  assert.equal(insertedRows[0].id, result.documentId, "el id insertado debe coincidir con el devuelto");
});

test("uploadSupportingDocument: archivo más grande que MAX_SUPPORTING_DOCUMENT_SIZE_BYTES -> rechaza ANTES de tocar Storage/la base (auditoría de Vercel readiness: antes este upload no tenía ningún tope)", async () => {
  const insertedRows: Record<string, unknown>[] = [];
  const uploadCalls: unknown[] = [];
  const supabase = {
    storage: {
      from() {
        return {
          upload: (...args: unknown[]) => {
            uploadCalls.push(args);
            return Promise.resolve({ data: { path: "x" }, error: null });
          },
        };
      },
    },
    from(table: string) {
      if (table === "supporting_documents") {
        return { insert: (row: Record<string, unknown>) => (insertedRows.push(row), Promise.resolve({ data: null, error: null })) };
      }
      throw new Error(`unexpected table ${table}`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  await assert.rejects(
    () =>
      uploadSupportingDocument(supabase, {
        employeeId: EMPLOYEE_ID,
        documentType: "OTHER",
        originalFilename: "foto.jpg",
        mimeType: "image/jpeg",
        fileBytes: new Uint8Array(MAX_SUPPORTING_DOCUMENT_SIZE_BYTES + 1),
      }),
    /tamaño máximo/
  );
  assert.deepEqual(uploadCalls, [], "un archivo demasiado grande nunca debe llegar a subirse a Storage");
  assert.deepEqual(insertedRows, [], "un archivo demasiado grande nunca debe insertar metadata");
});

test("uploadSupportingDocument: relation ausente -> documento general sin FK a ningún caso puntual", async () => {
  const insertedRows: Record<string, unknown>[] = [];
  const supabase = mockSupabase({ insertedRows });

  await uploadSupportingDocument(supabase, {
    employeeId: EMPLOYEE_ID,
    documentType: "OTHER",
    originalFilename: "a.pdf",
    mimeType: "application/pdf",
    fileBytes: new Uint8Array([1]),
  });

  assert.ok(!("absence_record_id" in insertedRows[0]));
  assert.ok(!("late_arrival_decision_id" in insertedRows[0]));
  assert.ok(!("early_departure_record_id" in insertedRows[0]));
});

test("getSignedDocumentUrl: sin acceso a la fila base -> error, nunca una URL", async () => {
  const supabase = mockSupabase({ insertedRows: [], docRow: null });
  await assert.rejects(() => getSignedDocumentUrl(supabase, "doc-1"));
});

test("getSignedDocumentUrl: con acceso -> URL firmada de Storage", async () => {
  const supabase = mockSupabase({ insertedRows: [], docRow: { storage_path: "e1/doc.pdf" } });
  const url = await getSignedDocumentUrl(supabase, "doc-1");
  assert.equal(url, "https://example.test/signed");
});

// ---------------------------------------------------------------------------
// El archivo no puede llegar a Storage si el INSERT va a fallar
// ---------------------------------------------------------------------------

/**
 * El archivo se sube primero y la metadata después. Un INSERT que falla deja
 * el archivo huérfano: con datos personales dentro, sin fila que lo
 * referencie, y --como el bucket no tiene policy de DELETE para nadie, a
 * propósito-- imposible de borrar desde la aplicación.
 */
function trackingClient() {
  const uploads: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = {
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => {
          uploads.push(args);
          return Promise.resolve({ data: { path: "x" }, error: null });
        },
      }),
    },
    from: () => ({ insert: () => Promise.resolve({ data: null, error: null }) }),
  };
  return { supabase, uploads };
}

const VALID_DOC = {
  employeeId: EMPLOYEE_ID,
  originalFilename: "certificado.pdf",
  mimeType: "application/pdf",
  fileBytes: new Uint8Array([1, 2, 3]),
};

test("uploadSupportingDocument: un document_type fuera del CHECK se rechaza ANTES de subir el archivo", async () => {
  const { supabase, uploads } = trackingClient();

  await assert.rejects(
    // Las Server Actions lo reciben del formulario con un `as` que nadie
    // verifica, así que este valor llega de verdad hasta acá.
    () => uploadSupportingDocument(supabase, { ...VALID_DOC, documentType: "INVENTADO" as never }),
    /tipo de documento no válido/i
  );
  assert.equal(uploads.length, 0, "no debe quedar nada en Storage");
});

test("uploadSupportingDocument: un employeeId que no es UUID se rechaza ANTES de subir el archivo", async () => {
  const { supabase, uploads } = trackingClient();

  await assert.rejects(
    () => uploadSupportingDocument(supabase, { ...VALID_DOC, employeeId: "e1", documentType: "OTHER" }),
    /trabajador no válido/i
  );
  assert.equal(uploads.length, 0, "no debe quedar nada en Storage");
});

test("uploadSupportingDocument: con datos válidos sí sube y la ruta arranca con el employeeId", async () => {
  const { supabase, uploads } = trackingClient();

  const { storagePath } = await uploadSupportingDocument(supabase, { ...VALID_DOC, documentType: "MEDICAL_CERTIFICATE" });
  assert.equal(uploads.length, 1);
  assert.ok(storagePath.startsWith(`${EMPLOYEE_ID}/`), `ruta inesperada: ${storagePath}`);
});
