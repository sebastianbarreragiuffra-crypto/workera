import type { ParsedMealMenu } from "./menu-docx";
import { buildMealFormOptions } from "./menu-options";

export interface WeeklyMealGoogleFormPayload {
  requestId: string;
  title: string;
  description: string;
  closeAtLocal: string;
  reminderAfterHours: number;
  employeeNames: string[];
  omittedDays: string[];
  questions: Array<{ title: string; options: string[] }>;
}

export function buildWeeklyMealGoogleFormPayload({
  menu,
  requestId,
  closeDate,
  closeTime,
  reminderAfterHours,
  employeeNames,
}: {
  menu: ParsedMealMenu;
  requestId: string;
  closeDate: string;
  closeTime: string;
  reminderAfterHours: number;
  employeeNames: string[];
}): WeeklyMealGoogleFormPayload {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closeDate) || !/^\d{2}:\d{2}$/.test(closeTime)) {
    throw new Error("Indica una fecha y hora de cierre válidas.");
  }
  if (!Number.isInteger(reminderAfterHours) || reminderAfterHours < 0 || reminderAfterHours > 168) {
    throw new Error("El plazo del recordatorio debe estar entre 0 y 168 horas.");
  }
  const canonicalEmployeeNames = [...new Set(employeeNames.map((name) => name.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "es"));
  if (canonicalEmployeeNames.length === 0 || canonicalEmployeeNames.length > 500) {
    throw new Error("La nómina activa para el formulario no es válida.");
  }

  return {
    requestId,
    title: menu.title,
    description: `El formulario se cierra el ${closeDate} a las ${closeTime}.`,
    closeAtLocal: `${closeDate}T${closeTime}:00`,
    reminderAfterHours,
    employeeNames: canonicalEmployeeNames,
    omittedDays: menu.omittedDays,
    questions: menu.days.map((day) => ({
      title: day.day,
      options: [...buildMealFormOptions(day), "No vengo a trabajar"],
    })),
  };
}
