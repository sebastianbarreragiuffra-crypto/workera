const CHILE_TIME_ZONE = "America/Santiago";
const FRIDAY = 5;
const CLOSING_HOUR = 13;

export interface WeeklyMealFormClosing {
  closeDate: string;
  closeTime: "13:00";
}

function chileDateParts(now: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHILE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

export function getNextFridayMealFormClosing(now = new Date()): WeeklyMealFormClosing {
  const local = chileDateParts(now);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  let daysUntilFriday = (FRIDAY - localDate.getUTCDay() + 7) % 7;
  const closingAlreadyPassed = localDate.getUTCDay() === FRIDAY
    && (local.hour > CLOSING_HOUR || (local.hour === CLOSING_HOUR && local.minute >= 0));
  if (closingAlreadyPassed) daysUntilFriday = 7;
  localDate.setUTCDate(localDate.getUTCDate() + daysUntilFriday);

  return {
    closeDate: localDate.toISOString().slice(0, 10),
    closeTime: "13:00",
  };
}
