import * as XLSX from "xlsx";

export interface ParsedMealMenuDay {
  day: string;
  menuOptions: string[];
  accompaniments: string[];
  extra: string | null;
}

export interface ParsedMealMenu {
  title: string;
  days: ParsedMealMenuDay[];
  omittedDays: string[];
}

type DayName = "LUNES" | "MARTES" | "MIERCOLES" | "JUEVES" | "VIERNES";

function normalizeLine(value: string) {
  return value.toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function parseDayHeading(value: string) {
  const normalized = normalizeLine(value);
  const match = /^(LUNES|MARTES|MIERCOLES|JUEVES|VIERNES)(?:\b|:)/.exec(normalized);
  if (!match) return null;
  return {
    day: match[1] as DayName,
    isHoliday: /\bFERIADO\b/.test(normalized.slice(match[0].length)),
  };
}

function isHolidayMarker(value: string) {
  return /^(DIA\s+)?FERIADO(?:\b|$)/.test(normalizeLine(value));
}

function decodeXmlText(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function extractParagraphs(xml: string) {
  return [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((paragraph) =>
      [...paragraph[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
        .map((text) => decodeXmlText(text[1]))
        .join("")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function splitOptions(value: string) {
  return value.split(/\s*\/\s*/).map((option) => option.trim()).filter(Boolean);
}

export function parseMealMenuParagraphs(paragraphs: string[]): ParsedMealMenu {
  const firstDayIndex = paragraphs.findIndex((line) => parseDayHeading(line) !== null);
  if (firstDayIndex < 0) throw new Error("No se detectaron los días del menú en el documento.");

  const title = paragraphs.slice(0, firstDayIndex).join(" ").replace(/\s+/g, " ").trim();
  const parsedDays: Array<ParsedMealMenuDay & { isHoliday: boolean }> = [];
  let currentDay: (ParsedMealMenuDay & { isHoliday: boolean }) | null = null;

  for (const line of paragraphs.slice(firstDayIndex)) {
    const dayHeading = parseDayHeading(line);
    if (dayHeading) {
      currentDay = { day: dayHeading.day, menuOptions: [], accompaniments: [], extra: null, isHoliday: dayHeading.isHoliday };
      parsedDays.push(currentDay);
      continue;
    }
    if (!currentDay) continue;
    if (isHolidayMarker(line)) {
      currentDay.isHoliday = true;
      continue;
    }
    const separator = line.indexOf(":");
    const implicitField = separator < 0 ? /^(menu|acompañamiento|agregados?|extra)\s+(.+)$/i.exec(line) : null;
    const rawLabel = separator >= 0 ? line.slice(0, separator) : (implicitField?.[1] ?? "");
    const label = rawLabel.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const value = separator >= 0 ? line.slice(separator + 1).trim() : (implicitField?.[2]?.trim() ?? line.trim());
    if (label === "menu") currentDay.menuOptions.push(...splitOptions(value));
    else if (label === "acompanamiento" || label === "agregado" || label === "agregados") currentDay.accompaniments.push(...splitOptions(value));
    else if (label === "extra") currentDay.extra = value;
    else currentDay.menuOptions.push(...splitOptions(value));
  }

  if (parsedDays.length !== 5 || new Set(parsedDays.map((day) => day.day)).size !== 5) {
    throw new Error("El documento debe contener los días de lunes a viernes.");
  }

  const activeDays = parsedDays.filter((day) => !day.isHoliday);
  if (!activeDays.length || activeDays.some((day) => day.menuOptions.length === 0)) {
    throw new Error("El documento debe contener un menú reconocible de lunes a viernes.");
  }

  return {
    title: title || "Menú semanal de colaciones",
    days: activeDays.map((day) => ({
      day: day.day,
      menuOptions: day.menuOptions,
      accompaniments: day.accompaniments,
      extra: day.extra,
    })),
    omittedDays: parsedDays.filter((day) => day.isHoliday).map((day) => day.day),
  };
}

export function parseMealMenuDocx(bytes: Uint8Array): ParsedMealMenu {
  const container = XLSX.CFB.read(bytes, { type: "buffer" });
  const documentIndex = container.FullPaths.findIndex((entry: string) => entry.endsWith("/word/document.xml"));
  if (documentIndex < 0) throw new Error("El archivo no contiene un documento Word válido.");
  const content = container.FileIndex[documentIndex]?.content;
  if (!content) throw new Error("No se pudo leer el contenido del documento Word.");

  const xml = new TextDecoder("utf-8").decode(content instanceof Uint8Array ? content : new Uint8Array(content));
  return parseMealMenuParagraphs(extractParagraphs(xml));
}
