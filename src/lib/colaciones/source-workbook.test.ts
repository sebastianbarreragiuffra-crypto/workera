import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProductionMealDiscountRows, productionBillingCycleFor } from "./source-workbook";

test("el ciclo de cobro va del día 15 al día 15 del mes siguiente", () => {
  assert.deepEqual(productionBillingCycleFor("2026-07-15"), {
    start: "2026-07-15",
    end: "2026-08-15",
    name: "15 julio de 2026–15 agosto de 2026",
  });
});

test("detecta las columnas por encabezado aunque la hoja comience en una columna distinta", () => {
  const records = parseProductionMealDiscountRows([
    ["DESCUENTO ALMUERZOS TRABAJADORES"],
    ["Nombre", "Fecha", "Monto", "Total a Pagar", "Firma"],
    ["ALVAREZ CRISTOBAL", 46218, 2400, 4800, null],
    [null, 46220, 2250, null, null],
  ]);

  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    workerName: "ALVAREZ CRISTOBAL",
    area: "PRODUCCIÓN",
    date: "2026-07-15",
    weekStart: "2026-07-13",
    amount: 2400,
    sourceAmount: 2400,
    priceKind: "COLACIÓN",
    orderDetail: null,
  });
  assert.equal(records[1].workerName, "ALVAREZ CRISTOBAL");
  assert.equal(records[1].amount, 2250);
  assert.equal(records[1].priceKind, "SÁNDWICH VIERNES");
});

test("acepta fechas y montos escritos como texto en el formato chileno", () => {
  const records = parseProductionMealDiscountRows([
    [null, "Nombre", "Fecha", "Monto"],
    [null, "BERRIOS CARLOS", "24/07/2026", "$2.250"],
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0].date, "2026-07-24");
  assert.equal(records[0].amount, 2250);
});

test("corrige una tarifa de sándwich aplicada fuera del viernes", () => {
  const records = parseProductionMealDiscountRows([
    ["Nombre", "Fecha", "Monto"],
    ["PUGA TOMÁS", "20/07/2026", 2250],
  ]);

  assert.equal(records[0].sourceAmount, 2250);
  assert.equal(records[0].amount, 2400);
  assert.equal(records[0].priceKind, "COLACIÓN");
});

test("rechaza archivos sin las columnas obligatorias con un mensaje accionable", () => {
  assert.throws(
    () => parseProductionMealDiscountRows([["Trabajador", "Día", "Valor"]]),
    /Nombre, Fecha y Monto/,
  );
});
