import assert from "node:assert/strict";
import test from "node:test";
import { readSupportingDocumentCleanupStaleSeconds } from "./config";

test("el watchdog usa 26 horas para cubrir cron diario y jitter", () => {
  assert.equal(readSupportingDocumentCleanupStaleSeconds({}), 93600);
});

test("el umbral acepta solo segundos enteros dentro de una semana", () => {
  assert.equal(readSupportingDocumentCleanupStaleSeconds({
    SUPPORTING_DOCUMENT_CLEANUP_STALE_SECONDS: "3600",
  }), 3600);
  assert.equal(readSupportingDocumentCleanupStaleSeconds({
    SUPPORTING_DOCUMENT_CLEANUP_STALE_SECONDS: "604800",
  }), 604800);
  for (const raw of ["3599", "604801", "1.5", "-1", "texto", " 93600 "]) {
    assert.throws(
      () => readSupportingDocumentCleanupStaleSeconds({
        SUPPORTING_DOCUMENT_CLEANUP_STALE_SECONDS: raw,
      }),
      /invalido/,
    );
  }
});
