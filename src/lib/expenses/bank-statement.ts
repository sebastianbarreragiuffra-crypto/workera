export const EXPENSE_BANK_STATEMENT_MAX_BYTES = 2 * 1024 * 1024;
export const EXPENSE_BANK_STATEMENT_MAX_ROWS = 2_000;

export interface ExpenseBankStatementRow {
  date: string;
  amount: string;
  currency: string;
  reference: string;
  description: string | null;
}

export class ExpenseBankStatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpenseBankStatementError";
  }
}

const HEADER_ALIASES = {
  date: new Set(["fecha", "date", "fecha movimiento", "fecha transaccion"]),
  amount: new Set(["monto", "amount", "importe"]),
  currency: new Set(["moneda", "currency", "divisa"]),
  reference: new Set(["referencia", "reference", "numero operacion", "n operacion", "folio"]),
  description: new Set(["descripcion", "description", "detalle", "glosa"]),
} as const;
const UNSAFE_TEXT = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

type CanonicalHeader = keyof typeof HEADER_ALIASES;

function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function detectDelimiter(firstLine: string): "," | ";" | "\t" {
  const counts = ([",", ";", "\t"] as const).map((delimiter) => ({
    delimiter,
    count: [...firstLine].filter((character) => character === delimiter).length,
  }));
  counts.sort((left, right) => right.count - left.count);
  if (counts[0].count === 0) throw new ExpenseBankStatementError("No pudimos reconocer las columnas del CSV.");
  return counts[0].delimiter;
}

function firstLogicalLine(input: string): string {
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === '"') {
      if (quoted && input[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && (input[index] === "\n" || input[index] === "\r")) {
      return input.slice(0, index);
    }
  }
  return input;
}

function parseDelimited(input: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) quoted = true;
    else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }

  if (quoted) throw new ExpenseBankStatementError("El CSV contiene una celda entre comillas sin cerrar.");
  row.push(field);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function resolveHeaders(headers: string[]): Record<CanonicalHeader, number> {
  const normalized = headers.map(normalizeHeader);
  if (new Set(normalized).size !== normalized.length) {
    throw new ExpenseBankStatementError("El CSV contiene nombres de columna repetidos.");
  }

  const resolved = {} as Record<CanonicalHeader, number>;
  for (const key of Object.keys(HEADER_ALIASES) as CanonicalHeader[]) {
    const matches = normalized
      .map((header, index) => HEADER_ALIASES[key].has(header) ? index : -1)
      .filter((index) => index >= 0);
    if (matches.length > 1) {
      throw new ExpenseBankStatementError(`El CSV contiene más de una columna para ${key}.`);
    }
    resolved[key] = matches[0] ?? -1;
  }
  for (const required of ["date", "amount", "currency", "reference"] as const) {
    if (resolved[required] < 0) {
      throw new ExpenseBankStatementError("El CSV debe incluir las columnas fecha, monto, moneda y referencia.");
    }
  }
  return resolved;
}

function normalizeDate(raw: string): string | null {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const local = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(value);
  const parts = iso ? [iso[1], iso[2], iso[3]] : local ? [local[3], local[2], local[1]] : null;
  if (!parts) return null;
  const [year, month, day] = parts;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return null;
  return `${year}-${month}-${day}`;
}

function normalizeAmount(raw: string): string | null {
  let value = raw.trim().replace(/\s/g, "").replace(/^\$/, "");
  const negativeInParentheses = /^\(.+\)$/.test(value);
  if (negativeInParentheses) value = value.slice(1, -1);
  value = value.replace(/^[+-]/, "");
  if (!/^\d[\d.,]*$/.test(value)) return null;

  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const groupingSeparator = decimalSeparator === "," ? "." : ",";
    value = value.split(groupingSeparator).join("").replace(decimalSeparator, ".");
  } else if (comma >= 0 || dot >= 0) {
    const separator = comma >= 0 ? "," : ".";
    const pieces = value.split(separator);
    if (pieces.length > 2) value = pieces.join("");
    else if (pieces[1]?.length === 3) value = pieces.join("");
    else value = pieces.join(".");
  }

  if (!/^\d{1,12}(\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999_999_999_999.99) return null;
  return amount.toFixed(2);
}

function limited(value: string, maximum: number): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maximum && !UNSAFE_TEXT.test(trimmed) ? trimmed : null;
}

/**
 * Convierte una cartola CSV en el contrato mínimo del RPC. Solo conserva los
 * datos necesarios para conciliar; números de cuenta y el archivo original no
 * se almacenan en la base.
 */
export function parseExpenseBankStatementCsv(input: string): ExpenseBankStatementRow[] {
  const source = input.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(firstLogicalLine(source));
  const records = parseDelimited(source, delimiter);
  if (records.length < 2) throw new ExpenseBankStatementError("La cartola no contiene movimientos.");
  if (records.length - 1 > EXPENSE_BANK_STATEMENT_MAX_ROWS) {
    throw new ExpenseBankStatementError("La cartola supera el máximo de 2.000 movimientos.");
  }

  const headers = resolveHeaders(records[0]);
  return records.slice(1).map((record, index) => {
    const sourceRow = index + 2;
    if (record.length > records[0].length) throw new ExpenseBankStatementError(`La fila ${sourceRow} tiene más columnas que el encabezado.`);
    const date = normalizeDate(record[headers.date] ?? "");
    const amount = normalizeAmount(record[headers.amount] ?? "");
    const currency = (record[headers.currency] ?? "").trim().toUpperCase();
    const reference = limited(record[headers.reference] ?? "", 120);
    const rawDescription = headers.description >= 0 ? record[headers.description] ?? "" : "";
    const description = rawDescription.trim() === "" ? null : limited(rawDescription, 240);

    if (!date) throw new ExpenseBankStatementError(`La fecha de la fila ${sourceRow} no es válida.`);
    if (!amount) throw new ExpenseBankStatementError(`El monto de la fila ${sourceRow} no es válido.`);
    if (!/^[A-Z]{3}$/.test(currency)) throw new ExpenseBankStatementError(`La moneda de la fila ${sourceRow} debe tener tres letras, por ejemplo CLP.`);
    if (!reference) throw new ExpenseBankStatementError(`La referencia de la fila ${sourceRow} está vacía o es demasiado larga.`);
    if (rawDescription.trim() !== "" && !description) throw new ExpenseBankStatementError(`La descripción de la fila ${sourceRow} supera 240 caracteres.`);

    return { date, amount, currency, reference, description };
  });
}
