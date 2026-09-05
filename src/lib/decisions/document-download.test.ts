import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentContentDisposition,
  authorizeSupportingDocumentDownload,
  privateSupportingDocumentHeaders,
  supportingDocumentDownloadFailureResponse,
} from "./document-download";

const DOCUMENT_ID = "75000000-0000-4000-8000-000000000001";

function mockClient(result: { data: unknown; error: { code?: string } | null }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const client = {
    rpc(name: string, args: unknown) {
      calls.push({ name, args });
      return { maybeSingle: () => Promise.resolve(result) };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, calls };
}

test("autoriza por el RPC cerrado y mapea solo metadata necesaria para entregar bytes", async () => {
  const { client, calls } = mockClient({
    data: {
      allowed: true,
      request_limit: 60,
      remaining: 59,
      retry_after_seconds: 0,
      storage_path: "employee/intent.pdf",
      original_filename: "licencia médica.pdf",
      mime_type: "application/pdf",
    },
    error: null,
  });

  assert.deepEqual(await authorizeSupportingDocumentDownload(client, DOCUMENT_ID), {
    status: "ALLOWED",
    storagePath: "employee/intent.pdf",
    originalFilename: "licencia médica.pdf",
    mimeType: "application/pdf",
    remaining: 59,
    requestLimit: 60,
  });
  assert.deepEqual(calls, [{
    name: "authorize_supporting_document_download",
    args: { p_document_id: DOCUMENT_ID },
  }]);
});

test("un bloqueo de cuota nunca expone ruta ni filename", async () => {
  const { client } = mockClient({
    data: {
      allowed: false,
      request_limit: 60,
      remaining: 0,
      retry_after_seconds: 201,
      storage_path: null,
      original_filename: null,
      mime_type: null,
    },
    error: null,
  });
  assert.deepEqual(await authorizeSupportingDocumentDownload(client, DOCUMENT_ID), {
    status: "RATE_LIMITED",
    retryAfterSeconds: 201,
    requestLimit: 60,
  });
});

test("distingue denegación esperada de indisponibilidad y falla cerrado ante filas incompletas", async () => {
  for (const code of ["42501", "22023", "P0002"]) {
    const { client } = mockClient({ data: null, error: { code } });
    assert.deepEqual(await authorizeSupportingDocumentDownload(client, DOCUMENT_ID), { status: "DENIED" });
  }
  const unavailable = mockClient({ data: null, error: { code: "08006" } }).client;
  assert.deepEqual(await authorizeSupportingDocumentDownload(unavailable, DOCUMENT_ID), { status: "UNAVAILABLE" });

  const malformed = mockClient({
    data: {
      allowed: true,
      request_limit: 60,
      remaining: 59,
      retry_after_seconds: 0,
      storage_path: null,
      original_filename: "documento.pdf",
      mime_type: "application/pdf",
    },
    error: null,
  }).client;
  assert.deepEqual(await authorizeSupportingDocumentDownload(malformed, DOCUMENT_ID), { status: "UNAVAILABLE" });
});

test("las respuestas de rechazo no cachean y 429 incluye Retry-After", () => {
  const denied = supportingDocumentDownloadFailureResponse({ status: "DENIED" });
  assert.equal(denied?.status, 404);
  assert.equal(denied?.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(denied?.headers.get("x-content-type-options"), "nosniff");
  assert.equal(denied?.headers.get("cross-origin-resource-policy"), "same-origin");

  const limited = supportingDocumentDownloadFailureResponse({
    status: "RATE_LIMITED",
    retryAfterSeconds: 42,
    requestLimit: 60,
  });
  assert.equal(limited?.status, 429);
  assert.equal(limited?.headers.get("retry-after"), "42");

  const unavailable = supportingDocumentDownloadFailureResponse({ status: "UNAVAILABLE" });
  assert.equal(unavailable?.status, 503);
});

test("Content-Disposition neutraliza CRLF/comillas y conserva un filename UTF-8", () => {
  const header = attachmentContentDisposition("\r\nmalicioso\".pdf");
  assert.ok(!header.includes("\r"));
  assert.ok(!header.includes("\n"));
  assert.match(header, /^attachment; filename="malicioso_\.pdf"; filename\*=UTF-8''/);

  const unicode = attachmentContentDisposition("licencia médica.pdf");
  assert.match(unicode, /filename="licencia medica\.pdf"/);
  assert.match(unicode, /filename\*=UTF-8''licencia%20m%C3%A9dica\.pdf/);
});

test("los bytes se fuerzan como adjunto no ejecutable, no inline", () => {
  const headers = privateSupportingDocumentHeaders("documento.pdf", 123);
  assert.equal(headers["Content-Type"], "application/octet-stream");
  assert.match(headers["Content-Disposition"], /^attachment;/);
  assert.equal(headers["Content-Length"], "123");
  assert.equal(headers["Content-Security-Policy"], "sandbox");
  assert.equal(headers["X-Download-Options"], "noopen");
  assert.equal(headers["Cache-Control"], "private, no-store, max-age=0");
});
