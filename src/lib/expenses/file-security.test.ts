import { test } from "node:test";
import assert from "node:assert/strict";
import { expenseFileSecurityLabel, isExpenseFileReleased, type ExpenseFileSecurityStatus } from "./file-security";

test("solo CLEAN o la validación interna explícita liberan bytes", () => {
  const expected: Record<ExpenseFileSecurityStatus, boolean> = {
    VALIDATED_INTERNAL: true,
    PENDING_SCAN: false,
    SCANNING: false,
    CLEAN: true,
    REJECTED: false,
    SCAN_FAILED: false,
  };
  for (const [status, released] of Object.entries(expected)) {
    assert.equal(isExpenseFileReleased(status as ExpenseFileSecurityStatus), released, status);
  }
});

test("los estados no liberados tienen una explicación segura para la bandeja", () => {
  for (const status of ["PENDING_SCAN", "SCANNING", "REJECTED", "SCAN_FAILED"] as const) {
    assert.ok(expenseFileSecurityLabel(status));
  }
  assert.equal(expenseFileSecurityLabel("CLEAN"), null);
  assert.equal(expenseFileSecurityLabel("VALIDATED_INTERNAL"), null);
});
