import { test } from "node:test";
import assert from "node:assert/strict";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { applyXlsxPresentation } from "./xlsx-postprocess";

function fixture(
  prefix: "" | "x:",
  options: { cellMetadataAttribute?: string; metadataName?: string; worksheetName?: string } = {},
): Uint8Array {
  const metadataName = options.metadataName ?? "metadata.xml";
  const worksheetName = options.worksheetName ?? "sheet1.xml";
  const namespace = prefix === "" ? ' xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' : ' xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const sheetData = options.cellMetadataAttribute
    ? `<${prefix}sheetData><${prefix}row r="1"><${prefix}c r="A1" ${options.cellMetadataAttribute}><${prefix}v>1</${prefix}v></${prefix}c></${prefix}row></${prefix}sheetData>`
    : `<${prefix}sheetData/>`;
  return zipSync({
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><${prefix}styleSheet${namespace}><${prefix}cellStyles count="0"/></${prefix}styleSheet>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><${prefix}workbook${namespace}><${prefix}sheets/></${prefix}workbook>`),
    [`xl/worksheets/${worksheetName}`]: strToU8(`<?xml version="1.0"?><${prefix}worksheet${namespace}>${sheetData}<${prefix}pageMargins/></${prefix}worksheet>`),
    [`xl/${metadataName}`]: strToU8('<?xml version="1.0"?><metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${worksheetName}"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata" Target="${metadataName}"/></Relationships>`),
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/${metadataName}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/></Types>`),
  });
}

for (const prefix of ["", "x:"] as const) {
  test(`applyXlsxPresentation: soporta namespace ${prefix === "" ? "por defecto" : "prefijado"}`, () => {
    const bytes = applyXlsxPresentation(fixture(prefix), [{
      sheetIndex: 1,
      freeze: { xSplit: 2, ySplit: 3, topLeftCell: "C4" },
      print: { orientation: "landscape", fitToWidth: 1 },
      conditionalFormats: [{ sqref: "A1:A5", formula: "A1<>0", fillRgb: "FFF2CC" }],
    }]);
    const archive = unzipSync(bytes);
    const sheet = strFromU8(archive["xl/worksheets/sheet1.xml"]);
    const styles = strFromU8(archive["xl/styles.xml"]);
    const workbook = strFromU8(archive["xl/workbook.xml"]);
    const relationships = strFromU8(archive["xl/_rels/workbook.xml.rels"]);
    const contentTypes = strFromU8(archive["[Content_Types].xml"]);

    assert.match(sheet, /<[^>]*pane [^>]*xSplit="2"[^>]*ySplit="3"[^>]*topLeftCell="C4"/);
    assert.match(sheet, /<[^>]*pageMargins [^>]*left="0\.25"[^>]*right="0\.25"/);
    assert.match(sheet, /<[^>]*pageSetup [^>]*orientation="landscape"[^>]*fitToWidth="1"[^>]*fitToHeight="0"/);
    assert.match(sheet, /conditionalFormatting sqref="A1:A5"/);
    assert.match(sheet, /<[^>]*formula>A1&lt;&gt;0<\/[^>]*formula>/);
    assert.match(styles, /<[^>]*dxfs count="1">/);
    assert.match(workbook, /<[^>]*calcPr [^>]*fullCalcOnLoad="1"[^>]*forceFullCalc="1"/);
    assert.equal(archive["xl/metadata.xml"], undefined);
    assert.doesNotMatch(relationships, /sheetMetadata/);
    assert.doesNotMatch(contentTypes, /sheetMetadata/);
    assert.match(relationships, /relationships\/worksheet/);
    assert.match(contentTypes, /spreadsheetml\.sheet\.main\+xml/);
  });
}

test("applyXlsxPresentation: elimina también metadata numerada cuando ninguna celda la usa", () => {
  const archive = unzipSync(applyXlsxPresentation(fixture("", { metadataName: "metadata1.xml" }), []));

  assert.equal(archive["xl/metadata1.xml"], undefined);
  assert.doesNotMatch(strFromU8(archive["xl/_rels/workbook.xml.rels"]), /sheetMetadata/);
  assert.doesNotMatch(strFromU8(archive["[Content_Types].xml"]), /sheetMetadata/);
});

test("applyXlsxPresentation: conserva metadata si una celda sí la referencia", () => {
  const archive = unzipSync(applyXlsxPresentation(fixture("", { cellMetadataAttribute: 'cm="1"' }), []));

  assert.ok(archive["xl/metadata.xml"]);
  assert.match(strFromU8(archive["xl/_rels/workbook.xml.rels"]), /sheetMetadata/);
  assert.match(strFromU8(archive["[Content_Types].xml"]), /sheetMetadata/);
});

test("applyXlsxPresentation: reconoce referencias con espacios, comillas simples y nombre de hoja no numerado", () => {
  const archive = unzipSync(applyXlsxPresentation(fixture("", {
    cellMetadataAttribute: "vm = '1'",
    worksheetName: "sheet.xml",
  }), []));

  assert.ok(archive["xl/metadata.xml"]);
  assert.match(strFromU8(archive["xl/_rels/workbook.xml.rels"]), /sheetMetadata/);
  assert.match(strFromU8(archive["[Content_Types].xml"]), /sheetMetadata/);
});
