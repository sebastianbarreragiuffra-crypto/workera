import type { ParsedMealMenuDay } from "./menu-docx";

const PROTEIN_WORDS = ["pollo", "churrasco", "vacuno", "cerdo", "pescado", "atun", "carne", "pavo", "ave"];
export const MANDATORY_DAILY_MEAL_OPTION = "Pollo con ensalada";

function normalize(value: string) {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function proteinBase(option: string): string | null {
  const normalized = normalize(option);
  if (!PROTEIN_WORDS.some((word) => normalized.includes(word))) return null;
  const separator = option.search(/\s+con\s+/i);
  return (separator > 0 ? option.slice(0, separator) : option).trim();
}

export function buildMealFormOptions(day: ParsedMealMenuDay): string[] {
  const options = new Map<string, string>();
  const add = (value: string) => options.set(normalize(value), value.trim());

  add(MANDATORY_DAILY_MEAL_OPTION);
  for (const option of day.menuOptions) {
    add(option);
    const base = proteinBase(option);
    if (!base) continue;
    for (const accompaniment of day.accompaniments) add(`${base} con ${accompaniment}`);
  }

  return [...options.values()];
}
