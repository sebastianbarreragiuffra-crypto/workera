export const BIRTHDAY_CONTRIBUTION_PER_PERSON = 1_000;

export function calculateBirthdayContributionPerWorker(birthdayCount: number): number {
  if (!Number.isInteger(birthdayCount) || birthdayCount < 0) {
    throw new Error("La cantidad de cumpleaños debe ser un número entero no negativo.");
  }
  return birthdayCount * BIRTHDAY_CONTRIBUTION_PER_PERSON;
}
