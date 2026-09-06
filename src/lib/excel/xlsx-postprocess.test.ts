import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { applyXlsxPresentation } from "./xlsx-postprocess";

function fixture(prefix: "" | "x:"): Uint8Array {
  const namespace = prefix === "" ? ' xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' : ' xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return zipSync({
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><${prefix}styleSheet${namespace}><${prefix}cellStyles count="0"/></${prefix}styleSheet>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><${prefix}workbook${namespace}><${prefix}sheets/></${prefix}workbook>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><${prefix}worksheet${namespace}><${prefix}sheetData/><${prefix}pageMargins/></${prefix}worksheet>`),
  });
}

for (const prefix of ["", "x:"] as const) {
  test(`applyXlsxPresentation: soporta namespace ${prefix === "" ? "por defecto" : "prefijado"}`, () => {
    const bytes = applyXlsxPresentation(fixture(prefix), [{
      sheetIndex: 1,
      freeze: { xSplit: 2, ySplit: 3, topLeftCell: "C4" },
      conditionalFormats: [{ sqref: "A1:A5", formula: "A1<>0", fillRgb: "FFF2CC" }],
    }]);
    const archive = unzipSync(bytes);
    const sheet = strFromU8(archive["xl/worksheets/sheet1.xml"]);
    const styles = strFromU8(archive["xl/styles.xml"]);
    const workbook = strFromU8(archive["xl/workbook.xml"]);

    assert.match(sheet, /<[^>]*pane [^>]*xSplit="2"[^>]*ySplit="3"[^>]*topLeftCell="C4"/);
    assert.match(sheet, /conditionalFormatting sqref="A1:A5"/);
    assert.match(sheet, /<[^>]*formula>A1&lt;&gt;0<\/[^>]*formula>/);
    assert.match(styles, /<[^>]*dxfs count="1">/);
    assert.match(workbook, /<[^>]*calcPr [^>]*fullCalcOnLoad="1"[^>]*forceFullCalc="1"/);
  });
}
