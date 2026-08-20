import type { CreatedWeeklyMealGoogleForm, WeeklyMealGoogleFormStatus } from "./google-forms";

export type MealFormResponseStatus = "ABIERTO" | "CERRADO";

export interface MealFormBusinessState {
  activeFormCount: 0 | 1;
  responseStatus: MealFormResponseStatus;
}

export function getMealFormBusinessState(
  form: CreatedWeeklyMealGoogleForm | null,
  status: WeeklyMealGoogleFormStatus | null,
  now = new Date(),
): MealFormBusinessState {
  if (!form || !status) return { activeFormCount: 0, responseStatus: "CERRADO" };

  const createdAt = new Date(form.createdAt);
  const closeAt = new Date(form.closeAtLocal);
  const hasValidPeriod = !Number.isNaN(createdAt.getTime()) && !Number.isNaN(closeAt.getTime());
  const isInsideResponsePeriod = hasValidPeriod
    && now.getTime() >= createdAt.getTime()
    && now.getTime() <= closeAt.getTime();
  const isActive = status.acceptingResponses && isInsideResponsePeriod;

  return {
    activeFormCount: isActive ? 1 : 0,
    responseStatus: isActive ? "ABIERTO" : "CERRADO",
  };
}
