import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWeeklyPeriod, resolveFortnightPeriod, resolveMonthlyPeriod } from "./attendance-export-periods";

test("resolveWeeklyPeriod: cualquier fecha de la semana resuelve al mismo lunes-domingo", () => {
  const wed = resolveWeeklyPeriod("2026-08-19");
  const mon = resolveWeeklyPeriod("2026-08-17");
  const sun = resolveWeeklyPeriod("2026-08-23");
  assert.equal(wed.startDate, "2026-08-17");
  assert.equal(wed.endDate, "2026-08-23");
  assert.deepEqual(wed, mon);
  assert.deepEqual(wed, sun);
  assert.equal(wed.type, "SEMANAL");
});

test("resolveWeeklyPeriod: cruza límite de mes correctamente", () => {
  const period = resolveWeeklyPeriod("2026-09-01"); // martes
  assert.equal(period.startDate, "2026-08-31");
  assert.equal(period.endDate, "2026-09-06");
});

test("resolveFortnightPeriod: primera quincena es SIEMPRE 1 al 15, sin importar el mes", () => {
  assert.deepEqual(
    { start: resolveFortnightPeriod("2026-08", 1).startDate, end: resolveFortnightPeriod("2026-08", 1).endDate },
    { start: "2026-08-01", end: "2026-08-15" }
  );
  assert.deepEqual(
    { start: resolveFortnightPeriod("2026-02", 1).startDate, end: resolveFortnightPeriod("2026-02", 1).endDate },
    { start: "2026-02-01", end: "2026-02-15" }
  );
});

test("resolveFortnightPeriod: segunda quincena es 16 al ÚLTIMO día calendario del mes, no una ventana fija de 14/15 días", () => {
  assert.deepEqual(
    { start: resolveFortnightPeriod("2026-08", 2).startDate, end: resolveFortnightPeriod("2026-08", 2).endDate },
    { start: "2026-08-16", end: "2026-08-31" } // agosto: 31 días
  );
  assert.deepEqual(
    { start: resolveFortnightPeriod("2026-04", 2).startDate, end: resolveFortnightPeriod("2026-04", 2).endDate },
    { start: "2026-04-16", end: "2026-04-30" } // abril: 30 días
  );
  assert.deepEqual(
    { start: resolveFortnightPeriod("2026-02", 2).startDate, end: resolveFortnightPeriod("2026-02", 2).endDate },
    { start: "2026-02-16", end: "2026-02-28" } // 2026 no es bisiesto
  );
});

test("resolveFortnightPeriod: 2028 es bisiesto -- segunda quincena de febrero llega hasta el 29", () => {
  const period = resolveFortnightPeriod("2028-02", 2);
  assert.equal(period.endDate, "2028-02-29");
});

test("resolveMonthlyPeriod: 1º al último día calendario del mes seleccionado", () => {
  assert.deepEqual(
    { start: resolveMonthlyPeriod("2026-08").startDate, end: resolveMonthlyPeriod("2026-08").endDate },
    { start: "2026-08-01", end: "2026-08-31" }
  );
  assert.deepEqual(
    { start: resolveMonthlyPeriod("2026-11").startDate, end: resolveMonthlyPeriod("2026-11").endDate },
    { start: "2026-11-01", end: "2026-11-30" }
  );
  assert.equal(resolveMonthlyPeriod("2026-08").type, "MENSUAL");
});
