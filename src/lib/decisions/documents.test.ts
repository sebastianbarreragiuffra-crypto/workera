import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SUPPORTING_DOCUMENT_SIZE_BYTES,
  uploadSupportingDocument,
  validateSupportingDocumentFile,
} from "./documents";

const EMPLOYEE_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const INTENT_ID = "4f2504e0-4f89-41d3-9a0c-0305e82c3302";
const STORAGE_PATH = `${EMPLOYEE_ID}/${INTENT_ID}.pdf`;
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mockSupabase(options: {
  failRegister?: boolean;
  failUpload?: boolean;
  failRemove?: boolean;
} = {}) {
  const calls: Array<{ kind: string; args: unknown }> = [];
  const client = {
    rpc(name: string, args: unknown) {
      calls.push({ kind: `rpc:${name}`, args });
      if (name === "reserve_supporting_document_upload") {
        return {
          single: () => Promise.resolve({
            data: { intent_id: INTENT_ID, storage_path: STORAGE_PATH },
            error: null,
          }),
        };
      }
      if (name === "register_supporting_document_upload") {
        return Promise.resolve(options.failRegister
          ? { data: null, error: { message: "register failed" } }
          : { data: "document-id", error: null });
      }
      throw new Error(`RPC inesperado: ${name}`);
    },
    storage: {
      from(bucket: string) {
        assert.equal(bucket, "supporting-documents");
        return {
          upload: (path: string, bytes: Uint8Array, uploadOptions: unknown) => {
            calls.push({ kind: "storage:upload", args: { path, bytes, uploadOptions } });
            return Promise.resolve(options.failUpload
              ? { data: null, error: { message: "upload failed" } }
              : { data: { path }, error: null });
          },
          remove: (paths: string[]) => {
            calls.push({ kind: "storage:remove", args: paths });
            return Promise.resolve(options.failRemove
              ? { data: null, error: { message: "remove failed" } }
              : { data: [], error: null });
          },
        };
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

const VALID_DOC = {
  employeeId: EMPLOYEE_ID,
  documentType: "MEDICAL_CERTIFICATE" as const,
  originalFilename: "certificado médico.pdf",
  mimeType: "application/pdf",
  fileBytes: PDF,
};

test("valida PDF/JPEG/PNG por magic bytes y devuelve MIME canónico", () => {
  assert.deepEqual(validateSupportingDocumentFile(PDF, "application/pdf"), { mimeType: "application/pdf", extension: "pdf" });
  assert.deepEqual(validateSupportingDocumentFile(JPEG, "image/jpeg"), { mimeType: "image/jpeg", extension: "jpg" });
  assert.deepEqual(validateSupportingDocumentFile(PNG, "application/octet-stream"), { mimeType: "image/png", extension: "png" });
});

test("rechaza archivo vacío, ejecutable disfrazado, MIME discordante y más de 10 MiB", () => {
  assert.throws(() => validateSupportingDocumentFile(new Uint8Array(), "application/pdf"), /vacío/i);
  assert.throws(() => validateSupportingDocumentFile(new Uint8Array([0x4d, 0x5a, 0x90]), "application/pdf"), /PDF, JPG o PNG/i);
  assert.throws(() => validateSupportingDocumentFile(PDF, "image/jpeg"), /no coincide/i);
  assert.throws(
    () => validateSupportingDocumentFile(new Uint8Array(MAX_SUPPORTING_DOCUMENT_SIZE_BYTES + 1), "application/pdf"),
    /tamaño máximo/i,
  );
});

test("reserva antes de subir y registra metadata por RPC; la ruta nunca contiene el filename", async () => {
  const { client, calls } = mockSupabase();
  const result = await uploadSupportingDocument(client, VALID_DOC);

  assert.deepEqual(result, { documentId: "document-id", storagePath: STORAGE_PATH });
  assert.deepEqual(calls.map((call) => call.kind), [
    "rpc:reserve_supporting_document_upload",
    "storage:upload",
    "rpc:register_supporting_document_upload",
  ]);
  assert.ok(!STORAGE_PATH.includes("certificado"));
  assert.deepEqual(calls[0].args, {
    p_employee_id: EMPLOYEE_ID,
    p_mime_type: "application/pdf",
    p_extension: "pdf",
    p_file_size: PDF.byteLength,
  });
});

test("un tipo de documento o employeeId inválido falla antes de reservar/subir", async () => {
  for (const input of [
    { ...VALID_DOC, documentType: "INVENTADO" as never },
    { ...VALID_DOC, employeeId: "e1" },
  ]) {
    const { client, calls } = mockSupabase();
    await assert.rejects(() => uploadSupportingDocument(client, input));
    assert.deepEqual(calls, []);
  }
});

test("un resultado incierto del upload intenta compensar y no registra metadata", async () => {
  const { client, calls } = mockSupabase({ failUpload: true });
  await assert.rejects(() => uploadSupportingDocument(client, VALID_DOC), /subir/i);
  assert.deepEqual(calls.map((call) => call.kind), ["rpc:reserve_supporting_document_upload", "storage:upload", "storage:remove"]);
});

test("un fallo del commit elimina por compensación el objeto aún huérfano", async () => {
  const { client, calls } = mockSupabase({ failRegister: true });
  await assert.rejects(() => uploadSupportingDocument(client, VALID_DOC), /registrar/i);
  assert.deepEqual(calls.map((call) => call.kind), [
    "rpc:reserve_supporting_document_upload",
    "storage:upload",
    "rpc:register_supporting_document_upload",
    "storage:remove",
  ]);
  assert.deepEqual(calls.at(-1)?.args, [STORAGE_PATH]);
});

test("las relaciones se envían al RPC cerrado y nunca se insertan desde TypeScript", async () => {
  const { client, calls } = mockSupabase();
  await uploadSupportingDocument(client, {
    ...VALID_DOC,
    relation: { kind: "ABSENCE", absenceRecordId: "absence-id" },
  });
  const register = calls.find((call) => call.kind === "rpc:register_supporting_document_upload");
  assert.deepEqual(register?.args, {
    p_intent_id: INTENT_ID,
    p_document_type: "MEDICAL_CERTIFICATE",
    p_original_filename: "certificado médico.pdf",
    p_absence_record_id: "absence-id",
    p_late_arrival_decision_id: null,
    p_early_departure_record_id: null,
  });
});
