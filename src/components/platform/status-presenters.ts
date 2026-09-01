import type { BadgeTone } from "../shell/Badge";
import type { CompanyLifecycleStatus, CompanyModuleStatus, CompanyOnboardingStatus } from "./types";

export interface StatusPresentation {
  label: string;
  tone: BadgeTone;
}

const COMPANY_STATUS: Record<CompanyLifecycleStatus, StatusPresentation> = {
  ACTIVE: { label: "Activa", tone: "positive" },
  ONBOARDING: { label: "En incorporación", tone: "info" },
  SUSPENDED: { label: "Suspendida", tone: "warning" },
  INACTIVE: { label: "Inactiva", tone: "neutral" },
};

const ONBOARDING_STATUS: Record<CompanyOnboardingStatus, StatusPresentation> = {
  NOT_STARTED: { label: "No iniciado", tone: "neutral" },
  IN_PROGRESS: { label: "En progreso", tone: "info" },
  BLOCKED: { label: "Requiere atención", tone: "warning" },
  COMPLETE: { label: "Completado", tone: "positive" },
};

const MODULE_STATUS: Record<CompanyModuleStatus, StatusPresentation> = {
  ENABLED: { label: "Habilitado", tone: "positive" },
  DISABLED: { label: "Deshabilitado", tone: "neutral" },
  PILOT: { label: "Piloto", tone: "info" },
  SETUP_REQUIRED: { label: "Configuración pendiente", tone: "warning" },
};

export function presentCompanyStatus(status: CompanyLifecycleStatus): StatusPresentation {
  return COMPANY_STATUS[status];
}

export function presentOnboardingStatus(status: CompanyOnboardingStatus): StatusPresentation {
  return ONBOARDING_STATUS[status];
}

export function presentModuleStatus(status: CompanyModuleStatus): StatusPresentation {
  return MODULE_STATUS[status];
}

export function onboardingProgress(completedSteps: number, totalSteps: number): number {
  if (!Number.isFinite(completedSteps) || !Number.isFinite(totalSteps) || totalSteps <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, completedSteps / totalSteps)) * 100);
}
