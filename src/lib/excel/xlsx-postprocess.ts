import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

export interface XlsxFreezePane {
  xSplit?: number;
  ySplit?: number;
  topLeftCell: string;
}

export interface XlsxConditionalFormat {
  /** Rango A1, por ejemplo `L6:L100`. */
  sqref: string;
  /** Fórmula OOXML sin `=` inicial y relativa a la primera celda de `sqref`. */
  formula: string;
  fillRgb: string;
  fontRgb?: string;
}

export interface XlsxPrintSetup {
  orientation: "portrait" | "landscape";
  /** Ajusta el ancho impreso sin forzar toda la tabla a una sola página vertical. */
  fitToWidth: number;
  fitToHeight?: number;
  paperSize?: number;
  margins?: {
    left: number;
    right: number;
    top: number;
    bottom: number;
    header: number;
    footer: number;
  };
}

export interface XlsxSheetPresentation {
  /** Orden físico de la hoja dentro del libro, comenzando en 1. */
  sheetIndex: number;
  freeze?: XlsxFreezePane;
  conditionalFormats?: XlsxConditionalFormat[];
  print?: XlsxPrintSetup;
}

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function argb(rgb: string): string {
  const normalized = rgb.replace(/^#/, "").toUpperCase();
  if (!/^(?:[0-9A-F]{6}|[0-9A-F]{8})$/.test(normalized)) {
    throw new Error(`Color XLSX inválido: ${rgb}`);
  }
  return normalized.length === 6 ? `FF${normalized}` : normalized;
}

function namespacePrefix(xml: string, rootName: string): string {
  const match = xml.match(new RegExp(`<([A-Za-z_][\\w.-]*:)?${rootName}\\b`));
  if (!match) throw new Error(`XLSX inválido: no se encontró ${rootName}`);
  return match[1] ?? "";
}

function paneXml(freeze: XlsxFreezePane, prefix: string): string {
  const xSplit = freeze.xSplit ?? 0;
  const ySplit = freeze.ySplit ?? 0;
  if (xSplit <= 0 && ySplit <= 0) return "";
  const activePane = xSplit > 0 && ySplit > 0 ? "bottomRight" : xSplit > 0 ? "topRight" : "bottomLeft";
  const splitAttributes = [
    xSplit > 0 ? `xSplit="${xSplit}"` : "",
    ySplit > 0 ? `ySplit="${ySplit}"` : "",
  ].filter(Boolean).join(" ");
  return `<${prefix}sheetViews><${prefix}sheetView workbookViewId="0"><${prefix}pane ${splitAttributes} topLeftCell="${xmlText(freeze.topLeftCell)}" activePane="${activePane}" state="frozen"/><${prefix}selection pane="${activePane}" activeCell="${xmlText(freeze.topLeftCell)}" sqref="${xmlText(freeze.topLeftCell)}"/></${prefix}sheetView></${prefix}sheetViews>`;
}

function applyFreeze(xml: string, freeze: XlsxFreezePane): string {
  const prefix = namespacePrefix(xml, "worksheet");
  const views = paneXml(freeze, prefix);
  const fullViews = /<(?:[A-Za-z_][\w.-]*:)?sheetViews(?:\s[^>]*)?>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?sheetViews>/;
  if (fullViews.test(xml)) {
    return xml.replace(fullViews, views);
  }
  const emptyViews = /<(?:[A-Za-z_][\w.-]*:)?sheetViews(?:\s[^>]*)?\s*\/>/;
  if (emptyViews.test(xml)) {
    return xml.replace(emptyViews, views);
  }
  return xml.replace(/(<(?:[A-Za-z_][\w.-]*:)?worksheet\b[^>]*>)/, `$1${views}`);
}

function applyPrintSetup(xml: string, print: XlsxPrintSetup): string {
  const prefix = namespacePrefix(xml, "worksheet");
  const margins = print.margins ?? {
    left: 0.25,
    right: 0.25,
    top: 0.5,
    bottom: 0.5,
    header: 0.2,
    footer: 0.2,
  };
  const pageMargins = `<${prefix}pageMargins left="${margins.left}" right="${margins.right}" top="${margins.top}" bottom="${margins.bottom}" header="${margins.header}" footer="${margins.footer}"/>`;
  const pageSetup = `<${prefix}pageSetup paperSize="${print.paperSize ?? 9}" orientation="${print.orientation}" fitToWidth="${print.fitToWidth}" fitToHeight="${print.fitToHeight ?? 0}"/>`;
  const existingMargins = /<(?:[A-Za-z_][\w.-]*:)?pageMargins\b[^>]*\/?>(?:[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?pageMargins>)?/;
  const existingSetup = /<(?:[A-Za-z_][\w.-]*:)?pageSetup\b[^>]*\/?>(?:[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?pageSetup>)?/;
  let result = existingMargins.test(xml)
    ? xml.replace(existingMargins, pageMargins)
    : xml.replace(`</${prefix}worksheet>`, `${pageMargins}</${prefix}worksheet>`);
  result = existingSetup.test(result)
    ? result.replace(existingSetup, pageSetup)
    : result.replace(`</${prefix}worksheet>`, `${pageSetup}</${prefix}worksheet>`);
  return result;
}

function dxfXml(rule: XlsxConditionalFormat, prefix: string): string {
  const font = rule.fontRgb
    ? `<${prefix}font><${prefix}color rgb="${argb(rule.fontRgb)}"/></${prefix}font>`
    : "";
  return `<${prefix}dxf>${font}<${prefix}fill><${prefix}patternFill patternType="solid"><${prefix}fgColor rgb="${argb(rule.fillRgb)}"/><${prefix}bgColor indexed="64"/></${prefix}patternFill></${prefix}fill></${prefix}dxf>`;
}

function appendDxfs(stylesXml: string, rules: XlsxConditionalFormat[]): { xml: string; firstDxfId: number } {
  const prefix = namespacePrefix(stylesXml, "styleSheet");
  const dxfs = rules.map((rule) => dxfXml(rule, prefix));
  if (dxfs.length === 0) return { xml: stylesXml, firstDxfId: 0 };

  const full = stylesXml.match(/<(?:[A-Za-z_][\w.-]*:)?dxfs\b[^>]*\bcount="(\d+)"[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?dxfs>/);
  if (full) {
    const currentCount = Number(full[1]);
    const replacement = full[0]
      .replace(/count="\d+"/, `count="${currentCount + dxfs.length}"`)
      .replace(/<\/(?:[A-Za-z_][\w.-]*:)?dxfs>$/, `${dxfs.join("")}</${prefix}dxfs>`);
    return { xml: stylesXml.replace(full[0], replacement), firstDxfId: currentCount };
  }

  const empty = stylesXml.match(/<(?:[A-Za-z_][\w.-]*:)?dxfs\b[^>]*\bcount="(\d+)"[^>]*\/>/);
  if (empty) {
    const currentCount = Number(empty[1]);
    const replacement = `<${prefix}dxfs count="${currentCount + dxfs.length}">${dxfs.join("")}</${prefix}dxfs>`;
    return { xml: stylesXml.replace(empty[0], replacement), firstDxfId: currentCount };
  }

  const block = `<${prefix}dxfs count="${dxfs.length}">${dxfs.join("")}</${prefix}dxfs>`;
  const tableStylesMarker = `<${prefix}tableStyles`;
  if (stylesXml.includes(tableStylesMarker)) {
    return { xml: stylesXml.replace(tableStylesMarker, `${block}${tableStylesMarker}`), firstDxfId: 0 };
  }
  return { xml: stylesXml.replace(`</${prefix}styleSheet>`, `${block}</${prefix}styleSheet>`), firstDxfId: 0 };
}

function appendConditionalFormats(
  sheetXml: string,
  rules: XlsxConditionalFormat[],
  firstDxfId: number,
  firstPriority: number
): string {
  if (rules.length === 0) return sheetXml;
  const prefix = namespacePrefix(sheetXml, "worksheet");
  const blocks = rules.map((rule, index) =>
    `<${prefix}conditionalFormatting sqref="${xmlText(rule.sqref)}"><${prefix}cfRule type="expression" dxfId="${firstDxfId + index}" priority="${firstPriority + index}"><${prefix}formula>${xmlText(rule.formula)}</${prefix}formula></${prefix}cfRule></${prefix}conditionalFormatting>`
  ).join("");
  const insertionPoint = [`<${prefix}ignoredErrors`, `<${prefix}pageMargins`, `<${prefix}pageSetup`, `<${prefix}headerFooter`, `</${prefix}worksheet>`]
    .map((marker) => sheetXml.indexOf(marker))
    .filter((position) => position >= 0)
    .sort((left, right) => left - right)[0];
  if (insertionPoint === undefined) throw new Error("XLSX inválido: no se encontró el cierre de worksheet");
  return `${sheetXml.slice(0, insertionPoint)}${blocks}${sheetXml.slice(insertionPoint)}`;
}

function forceFormulaRecalculation(workbookXml: string): string {
  const prefix = namespacePrefix(workbookXml, "workbook");
  const calcPr = `<${prefix}calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>`;
  const emptyCalcPr = /<(?:[A-Za-z_][\w.-]*:)?calcPr\b[^>]*\/>/;
  if (emptyCalcPr.test(workbookXml)) {
    return workbookXml.replace(emptyCalcPr, calcPr);
  }
  const fullCalcPr = /<(?:[A-Za-z_][\w.-]*:)?calcPr\b[^>]*>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?calcPr>/;
  if (fullCalcPr.test(workbookXml)) {
    return workbookXml.replace(fullCalcPr, calcPr);
  }
  return workbookXml.replace(`</${prefix}workbook>`, `${calcPr}</${prefix}workbook>`);
}

/**
 * Corrige dos carencias de `xlsx-js-style`: no serializa `!freeze` ni reglas
 * de formato condicional. El postproceso opera sobre OOXML estándar y obliga
 * a Excel a recalcular las fórmulas editables al abrir el archivo.
 */
export function applyXlsxPresentation(
  bytes: Uint8Array,
  sheets: readonly XlsxSheetPresentation[]
): Uint8Array {
  const archive = unzipSync(bytes);
  const textDecoder = (path: string): string => {
    const value = archive[path];
    if (!value) throw new Error(`XLSX inválido: falta ${path}`);
    return strFromU8(value);
  };

  const allRules = sheets.flatMap((sheet) => sheet.conditionalFormats ?? []);
  const dxfResult = appendDxfs(textDecoder("xl/styles.xml"), allRules);
  archive["xl/styles.xml"] = strToU8(dxfResult.xml);

  let dxfOffset = dxfResult.firstDxfId;
  let priority = 1;
  for (const sheet of sheets) {
    if (!Number.isInteger(sheet.sheetIndex) || sheet.sheetIndex < 1) {
      throw new Error(`Índice de hoja XLSX inválido: ${sheet.sheetIndex}`);
    }
    const path = `xl/worksheets/sheet${sheet.sheetIndex}.xml`;
    let xml = textDecoder(path);
    if (sheet.freeze) xml = applyFreeze(xml, sheet.freeze);
    if (sheet.print) xml = applyPrintSetup(xml, sheet.print);
    const rules = sheet.conditionalFormats ?? [];
    xml = appendConditionalFormats(xml, rules, dxfOffset, priority);
    dxfOffset += rules.length;
    priority += rules.length;
    archive[path] = strToU8(xml);
  }

  archive["xl/workbook.xml"] = strToU8(forceFormulaRecalculation(textDecoder("xl/workbook.xml")));
  return zipSync(archive, { level: 6 });
}
