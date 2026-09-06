import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("./DescargarAsistenciaCard.tsx", import.meta.url), "utf8");

test("DescargarAsistenciaCard ofrece exactamente las cuatro ventanas acordadas", () => {
  const values = [...source.matchAll(/<option value="([A-Z]+)">/g)].map((match) => match[1]);
  assert.deepEqual(values, ["DIARIO", "SEMANAL", "QUINCENAL", "MENSUAL"]);
  assert.match(source, /Diario \(1 día\)/);
  assert.match(source, /Mensual de remuneraciones \(16 al 15\)/);
});

test("la ventana diaria envía una fecha y la mensual usa el ciclo de remuneraciones", () => {
  assert.match(source, /params\.set\("tipo", "diario"\)[\s\S]*?params\.set\("fecha", diaFecha\)/);
  assert.match(source, /params\.set\("tipo", "mensual"\)[\s\S]*?params\.set\("mes", mensualMes\)/);
  assert.match(source, /tipo === "MENSUAL" && <PayrollWorkbookUpload month=\{mensualMes\}/);
  assert.doesNotMatch(source, /<option value="PAGO">/);
});
