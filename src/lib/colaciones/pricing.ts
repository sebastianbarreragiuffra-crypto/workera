export const PRODUCTION_MEAL_PRICES = {
  REGULAR_MEAL: 2400,
  FRIDAY_SANDWICH: 2250,
} as const;

export type ProductionMealPriceKind = "COLACIÓN" | "SÁNDWICH VIERNES";

export function getProductionMealPricing(dateIso: string, sourceAmount: number): {
  amount: number;
  kind: ProductionMealPriceKind;
} {
  const date = new Date(`${dateIso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha de colación inválida: ${dateIso}`);
  const isFridaySandwich = date.getUTCDay() === 5 && sourceAmount === PRODUCTION_MEAL_PRICES.FRIDAY_SANDWICH;
  return isFridaySandwich
    ? { amount: PRODUCTION_MEAL_PRICES.FRIDAY_SANDWICH, kind: "SÁNDWICH VIERNES" }
    : { amount: PRODUCTION_MEAL_PRICES.REGULAR_MEAL, kind: "COLACIÓN" };
}
