import type { ProductionMealPriceKind } from "./pricing";

export interface ProductionMealDiscountRecord {
  workerName: string;
  area: "PRODUCCIÓN";
  date: string;
  weekStart: string;
  amount: number;
  sourceAmount: number;
  priceKind: ProductionMealPriceKind;
  orderDetail: string | null;
}

export interface ProductionMealDiscountDataset {
  sourceFile: string;
  cycleName: string;
  cycleStart: string;
  cycleEnd: string;
  records: ProductionMealDiscountRecord[];
  registeredAmounts: number[];
  pricingMismatchCount: number;
}
