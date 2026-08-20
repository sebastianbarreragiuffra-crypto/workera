import { normalizeName } from "../business-rules/name-matching";

export interface MealEligibleWorker {
  employeeId: string;
  firstName: string;
  lastName: string;
  displayName: string;
}

export interface PendingMealWorker extends MealEligibleWorker {
  status: "PENDIENTE";
}

export interface MealResponseTracking {
  totalWorkers: number;
  respondedCount: number;
  pendingCount: number;
  pendingWorkers: PendingMealWorker[];
}

function workerAliases(worker: MealEligibleWorker) {
  const fullName = `${worker.firstName} ${worker.lastName}`.trim();
  return [...new Set([worker.displayName, fullName].map(normalizeName).filter(Boolean))];
}

export function buildMealResponseTracking(
  workers: MealEligibleWorker[],
  respondentNames: string[],
): MealResponseTracking {
  const availableResponses = new Map<string, number>();
  for (const name of respondentNames) {
    const normalized = normalizeName(name);
    if (normalized) availableResponses.set(normalized, (availableResponses.get(normalized) ?? 0) + 1);
  }

  const pendingWorkers: PendingMealWorker[] = [];
  for (const worker of workers) {
    const matchedAlias = workerAliases(worker).find((alias) => (availableResponses.get(alias) ?? 0) > 0);
    if (matchedAlias) {
      availableResponses.set(matchedAlias, (availableResponses.get(matchedAlias) ?? 1) - 1);
    } else {
      pendingWorkers.push({ ...worker, status: "PENDIENTE" });
    }
  }
  pendingWorkers.sort((a, b) => a.displayName.localeCompare(b.displayName, "es"));

  return {
    totalWorkers: workers.length,
    respondedCount: workers.length - pendingWorkers.length,
    pendingCount: pendingWorkers.length,
    pendingWorkers,
  };
}

export function buildMealReminderMessage(pendingWorkers: PendingMealWorker[], responderUrl: string): string {
  const pendingList = pendingWorkers.map((worker) => `- ${worker.displayName}`).join("\n");
  return `Recordatorio Colaciones:\n\nEstimados trabajadores, les recordamos completar el formulario de colaciones pendiente.\n\nLas siguientes personas aún no han respondido:\n\n${pendingList}\n\nFavor completar el formulario:\n\n${responderUrl}\n\nGracias.`;
}

export function mealReminderAvailableAt(createdAt: string, reminderAfterHours: number): Date | null {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime()) || !Number.isFinite(reminderAfterHours) || reminderAfterHours < 0) return null;
  return new Date(created.getTime() + reminderAfterHours * 60 * 60 * 1000);
}
