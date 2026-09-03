import "server-only";

import type {
  CompanyHeaderSummary,
  CompanyModuleItem,
  CompanyOnboardingStatus,
  CompanyOnboardingSummary,
  CompanyPortfolioItem,
  CompanyTabKey,
  OrganizationUnitNode,
} from "./types";
import { createClient } from "../supabase/server";
import type { Database, Json } from "../supabase/database.types";
import { requirePlatformSessionFromClient } from "./authorization";

type PlatformRole = Database["public"]["Enums"]["platform_role"];
type AppRole = Database["public"]["Enums"]["app_role"];
type CompanyLifecycleStatus = Database["public"]["Enums"]["company_lifecycle_status"];
type CompanyModuleStatus = Database["public"]["Enums"]["company_module_status"];
type CompanyInvitationStatus = Database["public"]["Enums"]["company_invitation_status"];
type CompanyOnboardingStepStatus = Database["public"]["Enums"]["company_onboarding_status"];
type OrganizationUnitKind = Database["public"]["Enums"]["organization_unit_type"];

export interface PlatformMemberRoleItem {
  id: string;
  code: string;
  name: string;
}

export interface PlatformMemberItem {
  membershipId: string;
  userId: string;
  displayName: string;
  /** El esquema público no expone email de auth.users al cliente de sesión. */
  email: string | null;
  active: boolean;
  /** Rol primario determinista para tablas compactas; `roles` conserva el RBAC multirol real. */
  roleId: string | null;
  roleName: string | null;
  roles: PlatformMemberRoleItem[];
}

export interface PlatformRoleItem {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  isSystem: boolean;
  baseRole: AppRole | null;
  memberCount: number;
  permissions: string[];
}

export interface PlatformInvitationItem {
  id: string;
  email: string;
  status: CompanyInvitationStatus;
  expiresAt: string;
  createdAt: string;
  roleId: string;
  roleName: string;
  deliveryStatus: "PENDING" | "SENT" | "ACCOUNT_EXISTS" | "FAILED";
  deliveryAttempts: number;
}

export interface PlatformOnboardingStepItem {
  stepKey: string;
  name: string;
  description: string;
  status: CompanyOnboardingStepStatus;
  notes: string | null;
  completedAt: string | null;
}

export interface PlatformAuditItem {
  id: number;
  actorName: string;
  action: string;
  targetType: string;
  targetId: string | null;
  createdAt: string;
}

export interface PlatformCompanyDetail {
  header: CompanyHeaderSummary;
  workspaceEnabled: boolean;
  planCode: string;
  countryCode: string;
  timezone: string;
  memberships: PlatformMemberItem[];
  modules: CompanyModuleItem[];
  roles: PlatformRoleItem[];
  invitations: PlatformInvitationItem[];
  onboardingSteps: PlatformOnboardingStepItem[];
  organization: OrganizationUnitNode[];
  audit: PlatformAuditItem[];
  memberPagination: { page: number; pageSize: number; totalCount: number };
  invitationPagination: { page: number; pageSize: number; totalCount: number };
}

export class PlatformDataAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformDataAccessError";
  }
}

export class PlatformCompanyNotFoundError extends PlatformDataAccessError {
  constructor() {
    super("La empresa solicitada no existe o no está disponible.");
    this.name = "PlatformCompanyNotFoundError";
  }
}

export interface PlatformPortfolioRow {
  active_members: number | string;
  available_modules: number | string;
  company_id: string;
  completed_steps: number | string;
  created_at: string;
  employee_count: number | string;
  enabled_modules: number | string;
  legal_name: string | null;
  name: string;
  next_step_label: string | null;
  plan_code: string;
  slug: string;
  status: CompanyLifecycleStatus;
  total_members: number | string;
  total_steps: number | string;
  workspace_enabled: boolean;
}

export interface PlatformPortfolioPageRow extends PlatformPortfolioRow {
  onboarding_blocked: boolean;
  total_count: number | string;
}

export interface PlatformPortfolioSummary {
  totalCompanies: number;
  activeCompanies: number;
  onboardingCompanies: number;
  activeMembers: number;
  enabledModules: number;
  pendingInvitations: number;
  setupRequiredModules: number;
  blockedOnboardingCompanies: number;
  suspendedCompanies: number;
}

interface PlatformPortfolioSummaryRow {
  total_companies: number | string;
  active_companies: number | string;
  onboarding_companies: number | string;
  active_members: number | string;
  enabled_modules: number | string;
  pending_invitations: number | string;
  setup_required_modules: number | string;
  blocked_onboarding_companies: number | string;
  suspended_companies: number | string;
}

export interface PlatformPortfolioPage {
  items: CompanyPortfolioItem[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export interface PlatformOrganizationRow {
  unit_id: string;
  parent_id: string | null;
  name: string;
  unit_type: OrganizationUnitKind;
  sort_order: number;
  direct_member_count: number | string;
  has_leader: boolean;
}

interface RawCompany {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  status: CompanyLifecycleStatus;
  workspace_enabled: boolean;
  plan_code: string;
  country_code: string;
  timezone: string;
}

interface RawMembership {
  id: string;
  user_id: string;
  active: boolean;
}

interface RawProfile {
  id: string;
  display_name: string;
  active: boolean;
}

interface RawMembershipRole {
  membership_id: string;
  role_id: string;
}

interface RawRole {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  is_system: boolean;
  base_role?: AppRole | null;
}

interface RawRolePermission {
  role_id: string;
  permission_code: string;
}

interface RawPermissionDefinition {
  code: string;
  module_key: string | null;
}

interface RawCompanyModule {
  module_key: string;
  status: CompanyModuleStatus;
  settings: Json;
  settings_version: number;
}

interface RawModuleDefinition {
  key: string;
  name: string;
  description: string;
  category: string;
  sort_order: number;
}

interface RawInvitation {
  id: string;
  email: string;
  status: CompanyInvitationStatus;
  expires_at: string;
  created_at: string;
  role_id: string;
  delivery_status?: "PENDING" | "SENT" | "ACCOUNT_EXISTS" | "FAILED";
  delivery_attempts?: number;
}

interface RawOnboardingStep {
  step_key: string;
  status: CompanyOnboardingStepStatus;
  notes: string | null;
  completed_at: string | null;
}

interface RawOnboardingDefinition {
  key: string;
  name: string;
  description: string;
  sort_order: number;
}

interface RawOrganizationUnit {
  id: string;
  parent_id: string | null;
  name: string;
  unit_type: OrganizationUnitKind;
  sort_order: number;
}

interface RawEmployeeAssignment {
  employee_id: string;
  org_unit_id: string;
  effective_from: string;
  effective_to: string | null;
  is_primary: boolean;
}

interface RawOrganizationLead {
  org_unit_id: string;
  effective_from: string;
  effective_to: string | null;
}

interface RawAudit {
  id: number;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  created_at: string;
}

interface QueryResult<T> {
  data: T | null;
  error: unknown;
}

function requireQueryData<T>(result: QueryResult<T>, label: string): T {
  if (result.error || result.data === null) {
    throw new PlatformDataAccessError(`No se pudo cargar ${label} del control plane.`);
  }
  return result.data;
}

function toCount(value: number | string): number {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function companyDetailHref(slug: string): string {
  return `/plataforma/empresas/${encodeURIComponent(slug)}`;
}

export function deriveOnboardingSummary(input: {
  completedSteps: number;
  totalSteps: number;
  nextStepLabel?: string | null;
  blocked?: boolean;
}): CompanyOnboardingSummary {
  const completedSteps = Math.max(0, input.completedSteps);
  const totalSteps = Math.max(0, input.totalSteps);
  let status: CompanyOnboardingStatus;

  if (input.blocked) status = "BLOCKED";
  else if (totalSteps > 0 && completedSteps >= totalSteps) status = "COMPLETE";
  else if (completedSteps > 0) status = "IN_PROGRESS";
  else status = "NOT_STARTED";

  return {
    status,
    completedSteps,
    totalSteps,
    nextStepLabel: input.nextStepLabel ?? null,
  };
}

export function mapPortfolioRows(
  rows: PlatformPortfolioRow[],
  blockedCompanyIds: ReadonlySet<string> = new Set()
): CompanyPortfolioItem[] {
  return rows.map((row) => ({
    id: row.company_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    workspaceEnabled: row.workspace_enabled,
    planCode: row.plan_code,
    onboarding: deriveOnboardingSummary({
      completedSteps: toCount(row.completed_steps),
      totalSteps: toCount(row.total_steps),
      nextStepLabel: row.next_step_label,
      blocked: blockedCompanyIds.has(row.company_id),
    }),
    users: {
      active: toCount(row.active_members),
      total: toCount(row.total_members),
    },
    modules: {
      enabled: toCount(row.enabled_modules),
      available: toCount(row.available_modules),
    },
    detailHref: companyDetailHref(row.slug),
  }));
}

export function mapOnboardingSteps(
  rows: RawOnboardingStep[],
  definitions: RawOnboardingDefinition[]
): PlatformOnboardingStepItem[] {
  const rowsByKey = new Map(rows.map((row) => [row.step_key, row]));
  return [...definitions]
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "es"))
    .map((definition) => {
      const row = rowsByKey.get(definition.key);
      return {
        stepKey: definition.key,
        name: definition.name,
        description: definition.description,
        status: row?.status ?? "NOT_STARTED",
        notes: row?.notes ?? null,
        completedAt: row?.completed_at ?? null,
      };
    });
}

function summarizeOnboarding(steps: PlatformOnboardingStepItem[]): CompanyOnboardingSummary {
  const completedSteps = steps.filter((step) => step.status === "COMPLETE").length;
  const blocked = steps.some((step) => step.status === "BLOCKED");
  return deriveOnboardingSummary({
    completedSteps,
    totalSteps: steps.length,
    nextStepLabel: steps.find((step) => step.status !== "COMPLETE")?.name ?? null,
    blocked,
  });
}

export function mapRoleItems(
  roles: RawRole[],
  rolePermissions: RawRolePermission[],
  membershipRoles: RawMembershipRole[]
): PlatformRoleItem[] {
  const permissionCodes = new Map<string, string[]>();
  const memberIds = new Map<string, Set<string>>();

  for (const permission of rolePermissions) {
    const current = permissionCodes.get(permission.role_id) ?? [];
    current.push(permission.permission_code);
    permissionCodes.set(permission.role_id, current);
  }
  for (const assignment of membershipRoles) {
    const current = memberIds.get(assignment.role_id) ?? new Set<string>();
    current.add(assignment.membership_id);
    memberIds.set(assignment.role_id, current);
  }

  return [...roles]
    .sort((a, b) => a.name.localeCompare(b.name, "es"))
    .map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      active: role.active,
      isSystem: role.is_system,
      baseRole: role.base_role ?? null,
      memberCount: memberIds.get(role.id)?.size ?? 0,
      permissions: [...(permissionCodes.get(role.id) ?? [])].sort(),
    }));
}

export function mapMemberItems(
  memberships: RawMembership[],
  profiles: RawProfile[],
  roles: RawRole[],
  membershipRoles: RawMembershipRole[]
): PlatformMemberItem[] {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const roleIdsByMembership = new Map<string, string[]>();

  for (const assignment of membershipRoles) {
    const current = roleIdsByMembership.get(assignment.membership_id) ?? [];
    current.push(assignment.role_id);
    roleIdsByMembership.set(assignment.membership_id, current);
  }

  return memberships
    .map((membership) => {
      const profile = profilesById.get(membership.user_id);
      if (!profile) {
        throw new PlatformDataAccessError("Una membresía no tiene un perfil accesible asociado.");
      }
      const assignedRoles = (roleIdsByMembership.get(membership.id) ?? [])
        .map((roleId) => rolesById.get(roleId))
        .filter((role): role is RawRole => Boolean(role))
        .sort((a, b) => a.name.localeCompare(b.name, "es"))
        .map((role) => ({ id: role.id, code: role.code, name: role.name }));
      const primaryRole = assignedRoles[0] ?? null;

      return {
        membershipId: membership.id,
        userId: membership.user_id,
        displayName: profile.display_name,
        email: null,
        active: membership.active && profile.active,
        roleId: primaryRole?.id ?? null,
        roleName: primaryRole?.name ?? null,
        roles: assignedRoles,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "es"));
}

function hasNonEmptySettings(settings: Json): boolean {
  return Boolean(settings && typeof settings === "object" && !Array.isArray(settings) && Object.keys(settings).length > 0);
}

export function mapModuleItems(input: {
  companyModules: RawCompanyModule[];
  moduleDefinitions: RawModuleDefinition[];
  roles: RawRole[];
  rolePermissions: RawRolePermission[];
  permissionDefinitions: RawPermissionDefinition[];
}): CompanyModuleItem[] {
  const modulesByKey = new Map(input.moduleDefinitions.map((module) => [module.key, module]));
  const roleById = new Map(input.roles.filter((role) => role.active).map((role) => [role.id, role]));
  const permissionModule = new Map(input.permissionDefinitions.map((permission) => [permission.code, permission.module_key]));
  const accessByModule = new Map<string, Set<string>>();

  for (const permission of input.rolePermissions) {
    const moduleKey = permissionModule.get(permission.permission_code);
    const role = roleById.get(permission.role_id);
    if (!moduleKey || !role) continue;
    const labels = accessByModule.get(moduleKey) ?? new Set<string>();
    labels.add(role.name);
    accessByModule.set(moduleKey, labels);
  }

  return input.companyModules
    .map((companyModule) => {
      const definition = modulesByKey.get(companyModule.module_key);
      if (!definition) {
        throw new PlatformDataAccessError("Un módulo habilitado no existe en el catálogo activo.");
      }
      return {
        item: {
          key: companyModule.module_key,
          name: definition.name,
          description: definition.description,
          category: definition.category,
          status: companyModule.status,
          accessLabels: [...(accessByModule.get(companyModule.module_key) ?? [])].sort((a, b) =>
            a.localeCompare(b, "es")
          ),
          configurationSummary: hasNonEmptySettings(companyModule.settings)
            ? `Configuración v${companyModule.settings_version}`
            : null,
        },
        sortOrder: definition.sort_order,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.item.name.localeCompare(b.item.name, "es"))
    .map((entry) => entry.item);
}

export function mapInvitationItems(invitations: RawInvitation[], roles: RawRole[]): PlatformInvitationItem[] {
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const now = Date.now();
  return [...invitations]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      status: invitation.status === "PENDING" && new Date(invitation.expires_at).getTime() <= now
        ? "EXPIRED"
        : invitation.status,
      expiresAt: invitation.expires_at,
      createdAt: invitation.created_at,
      roleId: invitation.role_id,
      roleName: rolesById.get(invitation.role_id)?.name ?? "Rol no disponible",
      deliveryStatus: invitation.delivery_status ?? "PENDING",
      deliveryAttempts: invitation.delivery_attempts ?? 0,
    }));
}

export function mapAuditItems(rows: RawAudit[], profiles: RawProfile[]): PlatformAuditItem[] {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile.display_name]));
  return rows.map((row) => ({
    id: row.id,
    actorName: profilesById.get(row.actor_id) ?? "Usuario de plataforma",
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    createdAt: row.created_at,
  }));
}

export function buildOrganizationTree(
  units: RawOrganizationUnit[],
  assignments: RawEmployeeAssignment[],
  effectiveDate: string,
  leads: RawOrganizationLead[] = []
): OrganizationUnitNode[] {
  const activeAssignments = assignments.filter(
    (assignment) =>
      assignment.is_primary &&
      assignment.effective_from <= effectiveDate &&
      (assignment.effective_to === null || assignment.effective_to >= effectiveDate)
  );
  const membersByUnit = new Map<string, Set<string>>();
  for (const assignment of activeAssignments) {
    const members = membersByUnit.get(assignment.org_unit_id) ?? new Set<string>();
    members.add(assignment.employee_id);
    membersByUnit.set(assignment.org_unit_id, members);
  }
  const unitsWithLeader = new Set(
    leads
      .filter((lead) => lead.effective_from <= effectiveDate && (lead.effective_to === null || lead.effective_to >= effectiveDate))
      .map((lead) => lead.org_unit_id)
  );

  const orderedUnits = [...units].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "es"));
  const nodes = new Map<string, OrganizationUnitNode>();
  for (const unit of orderedUnits) {
    nodes.set(unit.id, {
      id: unit.id,
      name: unit.name,
      kind: unit.unit_type,
      leaderName: null,
      hasLeader: unitsWithLeader.has(unit.id),
      memberCount: membersByUnit.get(unit.id)?.size ?? 0,
      children: [],
    });
  }

  const roots: OrganizationUnitNode[] = [];
  for (const unit of orderedUnits) {
    const node = nodes.get(unit.id)!;
    const parent = unit.parent_id ? nodes.get(unit.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const aggregateMembers = (node: OrganizationUnitNode): number => {
    const descendantCount = node.children.reduce((total, child) => total + aggregateMembers(child), 0);
    node.memberCount += descendantCount;
    return node.memberCount;
  };
  roots.forEach(aggregateMembers);
  return roots;
}

export function mapOrganizationProjection(rows: PlatformOrganizationRow[]): OrganizationUnitNode[] {
  const orderedRows = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "es"));
  const nodes = new Map<string, OrganizationUnitNode>();
  for (const row of orderedRows) {
    nodes.set(row.unit_id, {
      id: row.unit_id,
      name: row.name,
      kind: row.unit_type,
      leaderName: null,
      hasLeader: row.has_leader,
      memberCount: toCount(row.direct_member_count),
      children: [],
    });
  }
  const roots: OrganizationUnitNode[] = [];
  for (const row of orderedRows) {
    const node = nodes.get(row.unit_id)!;
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const aggregateMembers = (node: OrganizationUnitNode): number => {
    node.memberCount += node.children.reduce((total, child) => total + aggregateMembers(child), 0);
    return node.memberCount;
  };
  roots.forEach(aggregateMembers);
  return roots;
}

export async function getPlatformCompanyPortfolioPage(input: {
  search?: string | null;
  status?: CompanyLifecycleStatus | null;
  page?: number;
  pageSize?: number;
  companyId?: string | null;
} = {}): Promise<PlatformPortfolioPage> {
  const page = Math.max(1, Math.trunc(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(input.pageSize ?? 20)));
  const search = input.search?.trim().slice(0, 100) || null;
  const supabase = await createClient();
  await requirePlatformSessionFromClient(supabase);
  const args = {
    p_company_id: input.companyId ?? undefined,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
    p_search: search ?? undefined,
    p_status: input.status ?? undefined,
  };
  const result = await supabase.rpc("platform_company_portfolio_page", args);
  let rows = requireQueryData(result as QueryResult<PlatformPortfolioPageRow[]>, "la página del portafolio");
  let resolvedPage = page;
  if (rows.length === 0 && page > 1) {
    const firstPageResult = await supabase.rpc("platform_company_portfolio_page", { ...args, p_offset: 0 });
    rows = requireQueryData(firstPageResult as QueryResult<PlatformPortfolioPageRow[]>, "la primera página del portafolio");
    resolvedPage = 1;
  }
  const blockedIds = new Set(rows.filter((row) => row.onboarding_blocked).map((row) => row.company_id));
  return {
    items: mapPortfolioRows(rows, blockedIds),
    page: resolvedPage,
    pageSize,
    totalCount: rows.length > 0 ? toCount(rows[0].total_count) : 0,
  };
}

export async function getPlatformPortfolioSummary(): Promise<PlatformPortfolioSummary> {
  const supabase = await createClient();
  await requirePlatformSessionFromClient(supabase);
  const result = await supabase.rpc("platform_portfolio_summary");
  const rows = requireQueryData(result as QueryResult<PlatformPortfolioSummaryRow[]>, "el resumen del portafolio");
  const row = rows[0];
  if (!row) throw new PlatformDataAccessError("El resumen del portafolio no devolvió datos.");
  return {
    totalCompanies: toCount(row.total_companies),
    activeCompanies: toCount(row.active_companies),
    onboardingCompanies: toCount(row.onboarding_companies),
    activeMembers: toCount(row.active_members),
    enabledModules: toCount(row.enabled_modules),
    pendingInvitations: toCount(row.pending_invitations),
    setupRequiredModules: toCount(row.setup_required_modules),
    blockedOnboardingCompanies: toCount(row.blocked_onboarding_companies),
    suspendedCompanies: toCount(row.suspended_companies),
  };
}

function normalizeCompanySlug(companySlug: string): string {
  const slug = companySlug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new PlatformDataAccessError("El identificador de empresa no es válido.");
  }
  return slug;
}

export async function getPlatformCompanyDetail(
  companySlug: string,
  tab: CompanyTabKey = "overview",
  requestedMemberPage = 1,
  requestedInvitationPage = 1
): Promise<PlatformCompanyDetail> {
  const supabase = await createClient();
  await requirePlatformSessionFromClient(supabase);

  const slug = normalizeCompanySlug(companySlug);
  const companyResult = await supabase
    .from("companies")
    .select("id, name, slug, legal_name, status, workspace_enabled, plan_code, country_code, timezone")
    .eq("slug", slug)
    .maybeSingle();
  if (companyResult.error) {
    throw new PlatformDataAccessError("No se pudo cargar la empresa del control plane.");
  }
  if (!companyResult.data) throw new PlatformCompanyNotFoundError();
  const company = companyResult.data as RawCompany;
  const portfolioResult = await supabase.rpc("platform_company_portfolio_page", {
    p_company_id: company.id,
    p_limit: 1,
    p_offset: 0,
  });
  const portfolioRows = requireQueryData(
    portfolioResult as QueryResult<PlatformPortfolioPageRow[]>,
    "la proyección segura de la empresa"
  );
  const portfolioRow = portfolioRows[0];
  if (!portfolioRow) {
    throw new PlatformDataAccessError("La empresa no aparece en la proyección segura del portafolio.");
  }

  let memberships: PlatformMemberItem[] = [];
  let roles: PlatformRoleItem[] = [];
  let modules: CompanyModuleItem[] = [];
  let invitations: PlatformInvitationItem[] = [];
  let onboardingSteps: PlatformOnboardingStepItem[] = [];
  let organization: OrganizationUnitNode[] = [];
  let audit: PlatformAuditItem[] = [];
  const memberPage = Math.max(1, Math.trunc(requestedMemberPage));
  const memberPageSize = 25;
  let memberTotalCount = 0;
  const invitationPage = Math.max(1, Math.trunc(requestedInvitationPage));
  const invitationPageSize = 25;
  let invitationTotalCount = 0;

  if (tab === "overview") {
    const [stepsResult, definitionsResult] = await Promise.all([
      supabase
        .from("company_onboarding_steps")
        .select("step_key, status, notes, completed_at")
        .eq("company_id", company.id),
      supabase
        .from("onboarding_step_catalog")
        .select("key, name, description, sort_order")
        .eq("active", true),
    ]);
    onboardingSteps = mapOnboardingSteps(
      requireQueryData(stepsResult, "el onboarding de la empresa") as RawOnboardingStep[],
      requireQueryData(definitionsResult, "el catálogo de onboarding") as RawOnboardingDefinition[]
    );
  } else if (tab === "users") {
    const [membershipResult, rolesResult, rolePermissionsResult, invitationsResult] = await Promise.all([
      supabase
        .from("company_memberships")
        .select("id, user_id, active", { count: "exact" })
        .eq("company_id", company.id)
        .order("created_at", { ascending: true })
        .range((memberPage - 1) * memberPageSize, memberPage * memberPageSize - 1),
      supabase
        .from("company_roles")
        .select("id, code, name, description, active, is_system, base_role")
        .eq("company_id", company.id),
      supabase
        .from("company_role_permissions")
        .select("role_id, permission_code")
        .eq("company_id", company.id),
      supabase
        .from("company_invitations")
        .select("id, email, status, expires_at, created_at, role_id, delivery_status, delivery_attempts", { count: "exact" })
        .eq("company_id", company.id)
        .order("created_at", { ascending: false })
        .range((invitationPage - 1) * invitationPageSize, invitationPage * invitationPageSize - 1),
    ]);
    const rawMemberships = requireQueryData(membershipResult, "las membresías de la empresa") as RawMembership[];
    const rawRoles = requireQueryData(rolesResult, "los roles de la empresa") as RawRole[];
    const rawRolePermissions = requireQueryData(rolePermissionsResult, "los permisos de roles") as RawRolePermission[];
    const rawInvitations = requireQueryData(invitationsResult, "las invitaciones recientes") as RawInvitation[];
    memberTotalCount = membershipResult.count ?? rawMemberships.length;
    invitationTotalCount = invitationsResult.count ?? rawInvitations.length;
    const membershipIds = rawMemberships.map((membership) => membership.id);
    const userIds = rawMemberships.map((membership) => membership.user_id);
    const [membershipRolesResult, profilesResult] = await Promise.all([
      membershipIds.length > 0
        ? supabase.from("company_membership_roles").select("membership_id, role_id").eq("company_id", company.id).in("membership_id", membershipIds)
        : Promise.resolve({ data: [] as RawMembershipRole[], error: null }),
      userIds.length > 0
        ? supabase.from("profiles").select("id, display_name, active").in("id", userIds)
        : Promise.resolve({ data: [] as RawProfile[], error: null }),
    ]);
    const rawMembershipRoles = requireQueryData(membershipRolesResult, "las asignaciones de roles") as RawMembershipRole[];
    const profiles = requireQueryData(profilesResult, "los perfiles de miembros") as RawProfile[];
    memberships = mapMemberItems(rawMemberships, profiles, rawRoles, rawMembershipRoles);
    roles = mapRoleItems(rawRoles, rawRolePermissions, rawMembershipRoles);
    invitations = mapInvitationItems(rawInvitations, rawRoles);
  } else if (tab === "modules") {
    const [companyModulesResult, moduleDefinitionsResult, rolesResult, rolePermissionsResult, permissionDefinitionsResult] = await Promise.all([
      supabase.from("company_modules").select("module_key, status, settings, settings_version").eq("company_id", company.id),
      supabase.from("module_catalog").select("key, name, description, category, sort_order").eq("active", true),
      supabase.from("company_roles").select("id, code, name, description, active, is_system, base_role").eq("company_id", company.id),
      supabase.from("company_role_permissions").select("role_id, permission_code").eq("company_id", company.id),
      supabase.from("permission_definitions").select("code, module_key"),
    ]);
    modules = mapModuleItems({
      companyModules: requireQueryData(companyModulesResult, "los módulos de la empresa") as RawCompanyModule[],
      moduleDefinitions: requireQueryData(moduleDefinitionsResult, "el catálogo de módulos") as RawModuleDefinition[],
      roles: requireQueryData(rolesResult, "los roles de la empresa") as RawRole[],
      rolePermissions: requireQueryData(rolePermissionsResult, "los permisos de roles") as RawRolePermission[],
      permissionDefinitions: requireQueryData(permissionDefinitionsResult, "el catálogo de permisos") as RawPermissionDefinition[],
    });
  } else if (tab === "organization") {
    const organizationResult = await supabase.rpc("platform_company_organization", { p_company_id: company.id });
    organization = mapOrganizationProjection(
      requireQueryData(organizationResult, "el organigrama agregado de la empresa") as PlatformOrganizationRow[]
    );
  } else if (tab === "audit") {
    const auditResult = await supabase
      .from("platform_audit_log")
      .select("id, actor_id, action, target_type, target_id, created_at")
      .eq("company_id", company.id)
      .order("created_at", { ascending: false })
      .limit(50);
    const rawAudit = requireQueryData(auditResult, "la auditoría reciente de la empresa") as RawAudit[];
    const actorIds = [...new Set(rawAudit.map((row) => row.actor_id))];
    const profilesResult = actorIds.length > 0
      ? await supabase.from("profiles").select("id, display_name, active").in("id", actorIds)
      : { data: [] as RawProfile[], error: null };
    audit = mapAuditItems(rawAudit, requireQueryData(profilesResult, "los actores de auditoría") as RawProfile[]);
  }

  const onboarding = onboardingSteps.length > 0
    ? summarizeOnboarding(onboardingSteps)
    : deriveOnboardingSummary({
        completedSteps: toCount(portfolioRow.completed_steps),
        totalSteps: toCount(portfolioRow.total_steps),
        nextStepLabel: portfolioRow.next_step_label,
        blocked: portfolioRow.onboarding_blocked,
      });
  const header: CompanyHeaderSummary = {
    id: company.id,
    name: company.name,
    slug: company.slug,
    legalName: company.legal_name,
    status: company.status,
    onboarding,
    users: {
      active: toCount(portfolioRow.active_members),
      total: toCount(portfolioRow.total_members),
    },
    modules: {
      enabled: toCount(portfolioRow.enabled_modules),
      available: toCount(portfolioRow.available_modules),
    },
    employeeCount: toCount(portfolioRow.employee_count),
  };

  return {
    header,
    workspaceEnabled: company.workspace_enabled,
    planCode: company.plan_code,
    countryCode: company.country_code,
    timezone: company.timezone,
    memberships,
    modules,
    roles,
    invitations,
    onboardingSteps,
    organization,
    audit,
    memberPagination: { page: memberPage, pageSize: memberPageSize, totalCount: memberTotalCount },
    invitationPagination: { page: invitationPage, pageSize: invitationPageSize, totalCount: invitationTotalCount },
  };
}

/** Tipo exportado para consumidores que necesiten declarar el rol del actor sin importar el módulo de auth. */
export type PlatformActorRole = PlatformRole;
