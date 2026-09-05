import assert from "node:assert/strict";
import test from "node:test";
import {
  isSupportingDocumentCleanupExpectedActive,
  readSupportingDocumentCleanupStaleSeconds,
} from "./config";

test("el monitor solo exige el sweeper con opt-in exacto", () => {
  assert.equal(isSupportingDocumentCleanupExpectedActive({}), false);
  assert.equal(isSupportingDocumentCleanupExpectedActive({
    SUPPORTING_DOCUMENT_CLEANUP_MONITOR_EXPECT_ENABLED: "false",
  }), false);
  assert.equal(isSupportingDocumentCleanupExpectedActive({
    SUPPORTING_DOCUMENT_CLEANUP_MONITOR_EXPECT_ENABLED: "TRUE",
  }), false);
  assert.equal(isSupportingDocumentCleanupExpectedActive({
    SUPPORTING_DOCUMENT_CLEANUP_MONITOR_EXPECT_ENABLED: "true",
  }), true);
});

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
