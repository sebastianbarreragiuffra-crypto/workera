/** Contratos serializables del dominio de administración multiempresa. */

export type CompanyLifecycleStatus = "ACTIVE" | "ONBOARDING" | "SUSPENDED" | "INACTIVE";

export type CompanyOnboardingStatus = "NOT_STARTED" | "IN_PROGRESS" | "BLOCKED" | "COMPLETE";

export interface CompanyOnboardingSummary {
  status: CompanyOnboardingStatus;
  completedSteps: number;
  totalSteps: number;
  nextStepLabel?: string | null;
}

export interface CompanyUserSummary {
  active: number;
  total: number;
}

export interface CompanyModuleSummary {
  enabled: number;
  available: number;
}

export interface CompanyPortfolioItem {
  id: string;
  name: string;
  slug: string;
  status: CompanyLifecycleStatus;
  onboarding: CompanyOnboardingSummary;
  users: CompanyUserSummary;
  modules: CompanyModuleSummary;
  detailHref: string;
}

export type PortfolioKpiTone = "neutral" | "positive" | "warning" | "negative" | "info";

export interface PortfolioKpiItem {
  id: string;
  label: string;
  value: string | number;
  supportingText?: string | null;
  tone?: PortfolioKpiTone;
  href?: string | null;
}

export interface CompanyHeaderSummary {
  id: string;
  name: string;
  slug: string;
  legalName?: string | null;
  status: CompanyLifecycleStatus;
  onboarding: CompanyOnboardingSummary;
  users: CompanyUserSummary;
  modules: CompanyModuleSummary;
  employeeCount?: number | null;
}

export type CompanyTabKey = "overview" | "users" | "modules" | "organization" | "integrations" | "audit";

export interface CompanyTabItem {
  key: CompanyTabKey;
  label: string;
  href: string;
  active: boolean;
  count?: number | null;
}

export type CompanyModuleStatus = "ENABLED" | "DISABLED" | "PILOT" | "SETUP_REQUIRED";

export interface CompanyModuleItem {
  key: string;
  name: string;
  description: string;
  category: string;
  status: CompanyModuleStatus;
  accessLabels: string[];
  configurationSummary?: string | null;
}

export type OrganizationUnitKind = "COMPANY" | "DIVISION" | "AREA" | "DEPARTMENT" | "TEAM" | "OTHER";

export interface OrganizationUnitNode {
  id: string;
  name: string;
  kind: OrganizationUnitKind;
  leaderName?: string | null;
  hasLeader?: boolean;
  memberCount: number;
  children: OrganizationUnitNode[];
}
