export type WorkeraSyncHealthStatus = "HEALTHY" | "STALE" | "RUNNING" | "DEGRADED" | "UNKNOWN";

export interface WorkeraSyncHealth {
  status: WorkeraSyncHealthStatus;
  lastSuccess: { syncRunId: string; targetDate: string; finishedAt: string } | null;
  lastFailure: { syncRunId: string; targetDate: string; finishedAt: string | null; errorCategory: string | null } | null;
  currentlyRunning: { syncRunId: string; targetDate: string; startedAt: string }[];
}

/** Estado sintético explícito; no afirma nada sobre Workera ni staging. */
export async function getWorkeraSyncHealth(): Promise<WorkeraSyncHealth> {
  return {
    status: "HEALTHY",
    lastSuccess: {
      syncRunId: "e2e50000-0000-4000-8000-000000000001",
      targetDate: "2000-01-01",
      finishedAt: new Date().toISOString(),
    },
    lastFailure: null,
    currentlyRunning: [],
  };
}
