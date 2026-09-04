import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPENSE_BANK_STATEMENT_MAX_ROWS,
  ExpenseBankStatementError,
  parseExpenseBankStatementCsv,
} from "./bank-statement";

test("acepta CSV chileno, inglés y valores entre comillas", () => {
  assert.deepEqual(
    parseExpenseBankStatementCsv('fecha;monto;moneda;referencia;descripción\r\n02/09/2026;"$ 45.990";clp;TRX-9;"Reembolso, terreno"'),
    [{ date: "2026-09-02", amount: "45990.00", currency: "CLP", reference: "TRX-9", description: "Reembolso, terreno" }]
  );
  assert.equal(parseExpenseBankStatementCsv("date,amount,currency,reference\n2026-09-03,1234.56,USD,ABC")[0].amount, "1234.56");
});

test("normaliza débitos negativos y formatos de miles sin cambiar el valor", () => {
  const rows = parseExpenseBankStatementCsv("fecha;monto;moneda;referencia\n2026-09-01;-1.234.567,89;CLP;A\n2026-09-02;(12,345.67);USD;B");
  assert.deepEqual(rows.map((row) => row.amount), ["1234567.89", "12345.67"]);
});

test("rechaza encabezados insuficientes, repetidos y filas mal formadas", () => {
  assert.throws(() => parseExpenseBankStatementCsv("fecha;monto\n2026-09-01;1"), ExpenseBankStatementError);
  assert.throws(
    () => parseExpenseBankStatementCsv("fecha;monto;moneda;referencia;fecha\n2026-09-01;1;CLP;A;x"),
    /repetidos/i
  );
  assert.throws(
    () => parseExpenseBankStatementCsv("fecha;date;monto;moneda;referencia\n2026-09-01;2026-09-02;1;CLP;A"),
    /más de una columna para date/i
  );
  assert.throws(() => parseExpenseBankStatementCsv("fecha;monto;moneda;referencia\n31/02/2026;1;CLP;A"), /fecha.*fila 2/i);
  assert.throws(() => parseExpenseBankStatementCsv("fecha;monto;moneda;referencia\n2026-09-01;0;CLP;A"), /monto.*fila 2/i);
  assert.throws(() => parseExpenseBankStatementCsv('fecha;monto;moneda;referencia\n2026-09-01;1;CLP;"A'), /comillas/i);
});

test("acepta BOM, tabulaciones, comillas escapadas y descripción opcional", () => {
  const [row] = parseExpenseBankStatementCsv('\uFEFFfecha\tmonto\tmoneda\treferencia\tdetalle\n2026-09-01\t1000\tCLP\tREF\t"Pago ""operación"""');
  assert.equal(row.description, 'Pago "operación"');
});

test("rechaza controles y texto bidireccional en referencias o glosas", () => {
  assert.throws(
    () => parseExpenseBankStatementCsv('fecha;monto;moneda;referencia;detalle\n2026-09-01;1;CLP;REF;"Pago\noperación"'),
    /descripción.*fila 2/i
  );
  assert.throws(
    () => parseExpenseBankStatementCsv("fecha;monto;moneda;referencia\n2026-09-01;1;CLP;ABC\u202Edef"),
    /referencia.*fila 2/i
  );
  for (const control of ["\u061C", "\u200E", "\u200F"]) {
    assert.throws(
      () => parseExpenseBankStatementCsv(`fecha;monto;moneda;referencia\n2026-09-01;1;CLP;ABC${control}def`),
      /referencia.*fila 2/i
    );
  }
});

test("descarta columnas bancarias adicionales en vez de persistir datos de cuenta", () => {
  const [row] = parseExpenseBankStatementCsv("fecha;monto;moneda;referencia;numero_cuenta;saldo\n2026-09-01;1000;CLP;REF;123456;900000");
  assert.deepEqual(Object.keys(row), ["date", "amount", "currency", "reference", "description"]);
  assert.equal(JSON.stringify(row).includes("123456"), false);
  assert.equal(JSON.stringify(row).includes("900000"), false);
});

test("limita la cartola a 2.000 movimientos", () => {
  const lines = Array.from({ length: EXPENSE_BANK_STATEMENT_MAX_ROWS + 1 }, (_, index) => `2026-09-01;1;CLP;R${index}`);
  assert.throws(
    () => parseExpenseBankStatementCsv(`fecha;monto;moneda;referencia\n${lines.join("\n")}`),
    /2.000 movimientos/i
  );
});
