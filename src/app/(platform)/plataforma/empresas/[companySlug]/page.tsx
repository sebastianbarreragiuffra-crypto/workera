import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CompanyHeader,
  CompanyModuleMatrix,
  CompanyTabs,
  InviteMemberForm,
  ResendInvitationForm,
  MemberRoleForm,
  ResetMfaForm,
  ModuleStatusForm,
  OnboardingStepForm,
  OrganizationTree,
  OrganizationUnitForm,
  type CompanyTabItem,
  type CompanyTabKey,
  type OrganizationParentOption,
  type OrganizationUnitNode,
} from "@/components/platform";
import { Badge } from "@/components/shell/Badge";
import { SectionCard } from "@/components/shell/SectionCard";
import { listExpenseCompaniesFromClient } from "@/lib/expenses/access";
import { requirePlatformSession } from "@/lib/platform/authorization";
import {
  getPlatformCompanyDetail,
  PlatformCompanyNotFoundError,
  type PlatformCompanyDetail,
} from "@/lib/platform/portfolio";
import { createClient } from "@/lib/supabase/server";
import { presentOnboardingStatus } from "@/components/platform/status-presenters";

const TAB_LABELS: Array<{ key: CompanyTabKey; label: string }> = [
  { key: "overview", label: "Resumen" },
  { key: "users", label: "Usuarios y roles" },
  { key: "modules", label: "Módulos" },
  { key: "organization", label: "Organigrama" },
  { key: "audit", label: "Auditoría" },
];

function activeTab(value: string | string[] | undefined): CompanyTabKey {
  const candidate = Array.isArray(value) ? value[0] : value;
  return TAB_LABELS.some((tab) => tab.key === candidate) ? candidate as CompanyTabKey : "overview";
}

function buildTabs(slug: string, selected: CompanyTabKey, detail: PlatformCompanyDetail): CompanyTabItem[] {
  return TAB_LABELS.map((tab) => ({
    ...tab,
    active: tab.key === selected,
    href: `/plataforma/empresas/${encodeURIComponent(slug)}?tab=${tab.key}`,
    count:
      tab.key === "users" ? detail.header.users.total
      : tab.key === "modules" ? detail.header.modules.available
      : undefined,
  }));
}

function flattenOrganization(nodes: OrganizationUnitNode[], depth = 0): OrganizationParentOption[] {
  return nodes.flatMap((node) => [
    { id: node.id, name: node.name, depth },
    ...flattenOrganization(node.children, depth + 1),
  ]);
}

function formatDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeZone }).format(new Date(value));
}

function OverviewTab({ detail, canManage }: { detail: PlatformCompanyDetail; canManage: boolean }) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(300px,0.6fr)]">
      <SectionCard title="Onboarding">
        <ol className="divide-y divide-slate-100">
          {detail.onboardingSteps.map((step) => {
            const status = presentOnboardingStatus(step.status);
            return (
              <li key={step.stepKey} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-slate-900">{step.name}</h3>
                    <Badge label={status.label} tone={status.tone} />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{step.description}</p>
                  {step.notes && <p className="mt-1 text-xs font-medium leading-5 text-amber-800">{step.notes}</p>}
                </div>
                <OnboardingStepForm
                  companyId={detail.header.id}
                  stepKey={step.stepKey}
                  status={step.status}
                  canManage={canManage}
                  blockedReason={step.stepKey === "go_live" && !detail.workspaceEnabled
                    ? "Se habilita después del aislamiento MT-3D."
                    : undefined}
                />
              </li>
            );
          })}
        </ol>
      </SectionCard>

      <div className="space-y-5">
        <SectionCard title="Configuración del cliente">
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">Plan</dt><dd className="font-medium text-slate-900">{detail.planCode}</dd></div>
            <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">País</dt><dd className="font-medium text-slate-900">{detail.countryCode}</dd></div>
            <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">Zona horaria</dt><dd className="font-medium text-slate-900">{detail.timezone}</dd></div>
            <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">Workspace</dt><dd><Badge label={detail.workspaceEnabled ? "Habilitado" : "Bloqueado"} tone={detail.workspaceEnabled ? "positive" : "warning"} /></dd></div>
          </dl>
        </SectionCard>
        {!detail.workspaceEnabled && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
            <h2 className="text-sm font-semibold text-amber-950">Protección de datos activa</h2>
            <p className="mt-1 text-xs leading-5 text-amber-900/80">
              Esta empresa puede configurarse, pero no operar. El workspace solo se habilitará después de completar el aislamiento multi-tenant de todas las tablas y archivos.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function UsersTab({
  detail,
  canManage,
  canResetMfa,
}: {
  detail: PlatformCompanyDetail;
  canManage: boolean;
  canResetMfa: boolean;
}) {
  const assignableRoles = detail.roles
    .filter((role) => role.active && (!detail.workspaceEnabled || role.baseRole !== null))
    .map((role) => ({ id: role.id, name: role.name }));

  return (
    <div className="space-y-5">
      {canManage && (
        <SectionCard title="Invitar usuario">
          <InviteMemberForm companyId={detail.header.id} roles={assignableRoles} canManage />
        </SectionCard>
      )}

      <SectionCard title="Miembros de la empresa">
        {detail.memberships.length === 0 ? (
          <p className="text-sm text-slate-500">La empresa aún no tiene membresías.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-slate-500">
                <tr><th className="pb-3 pr-4">Persona</th><th className="px-4 pb-3">Estado</th><th className="px-4 pb-3">Roles actuales</th><th className="px-4 pb-3">Asignación</th><th className="pl-4 pb-3">Segundo factor</th></tr>
              </thead>
              <tbody>
                {detail.memberships.map((member) => (
                  <tr key={member.membershipId} className="border-b border-slate-100 last:border-0">
                    <td className="py-3 pr-4">
                      <div className="font-medium text-slate-900">{member.displayName}</div>
                      <div className="text-xs text-slate-400">{member.email ?? "Correo protegido por Auth"}</div>
                    </td>
                    <td className="px-4 py-3"><Badge label={member.active ? "Activo" : "Inactivo"} tone={member.active ? "positive" : "neutral"} /></td>
                    <td className="px-4 py-3 text-xs text-slate-600">{member.roles.map((role) => role.name).join(", ") || "Sin rol RBAC"}</td>
                    <td className="px-4 py-3">
                      <MemberRoleForm companyId={detail.header.id} membershipId={member.membershipId} selectedRoleId={member.roleId} roles={assignableRoles} canManage={canManage} membershipActive={member.active} />
                    </td>
                    <td className="pl-4 py-3">
                      {canResetMfa ? (
                        <ResetMfaForm userId={member.userId} displayName={member.displayName} />
                      ) : (
                        <span className="text-xs text-slate-400">Solo OWNER</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {detail.memberPagination.totalCount > detail.memberPagination.pageSize && (
          <nav className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-4" aria-label="Paginación de miembros">
            {detail.memberPagination.page > 1 && (
              <Link href={`?tab=users&memberPage=${detail.memberPagination.page - 1}&invitationPage=${detail.invitationPagination.page}`} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">← Anterior</Link>
            )}
            <span className="text-xs text-slate-500">Página {detail.memberPagination.page} de {Math.ceil(detail.memberPagination.totalCount / detail.memberPagination.pageSize)}</span>
            {detail.memberPagination.page * detail.memberPagination.pageSize < detail.memberPagination.totalCount && (
              <Link href={`?tab=users&memberPage=${detail.memberPagination.page + 1}&invitationPage=${detail.invitationPagination.page}`} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Siguiente →</Link>
            )}
          </nav>
        )}
      </SectionCard>

      <section className="grid gap-5 xl:grid-cols-2">
        <SectionCard title="Invitaciones registradas">
          {detail.invitations.length === 0 ? <p className="text-sm text-slate-500">No hay invitaciones registradas.</p> : (
            <ul className="divide-y divide-slate-100">
              {detail.invitations.map((invitation) => (
                <li key={invitation.id} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-slate-900">{invitation.email}</div>
                    <div className="text-xs text-slate-500">{invitation.roleName} · expira {formatDate(invitation.expiresAt, detail.timezone)}</div>
                    {invitation.status === "PENDING" && (
                      <div className="mt-1 text-xs text-slate-500">
                        {{ PENDING: "Correo aún no procesado", SENT: "Correo enviado", ACCOUNT_EXISTS: "Cuenta existente: debe iniciar sesión", FAILED: "No se pudo enviar el correo" }[invitation.deliveryStatus]}
                      </div>
                    )}
                    {invitation.status === "PENDING" && invitation.deliveryStatus === "FAILED" && canManage && (
                      <ResendInvitationForm companyId={detail.header.id} invitationId={invitation.id} />
                    )}
                  </div>
                  <Badge label={{ PENDING: "Pendiente", ACCEPTED: "Aceptada", REVOKED: "Revocada", EXPIRED: "Vencida" }[invitation.status]} tone={invitation.status === "PENDING" ? "warning" : invitation.status === "ACCEPTED" ? "positive" : "neutral"} />
                </li>
              ))}
            </ul>
          )}
          {detail.invitationPagination.totalCount > detail.invitationPagination.pageSize && (
            <nav className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-4" aria-label="Paginación de invitaciones">
              {detail.invitationPagination.page > 1 && (
                <Link href={`?tab=users&memberPage=${detail.memberPagination.page}&invitationPage=${detail.invitationPagination.page - 1}`} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">← Anterior</Link>
              )}
              <span className="text-xs text-slate-500">Página {detail.invitationPagination.page} de {Math.ceil(detail.invitationPagination.totalCount / detail.invitationPagination.pageSize)}</span>
              {detail.invitationPagination.page * detail.invitationPagination.pageSize < detail.invitationPagination.totalCount && (
                <Link href={`?tab=users&memberPage=${detail.memberPagination.page}&invitationPage=${detail.invitationPagination.page + 1}`} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">Siguiente →</Link>
              )}
            </nav>
          )}
        </SectionCard>

        <SectionCard title="Roles disponibles">
          <ul className="divide-y divide-slate-100">
            {detail.roles.map((role) => (
              <li key={role.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-3"><span className="text-sm font-medium text-slate-900">{role.name}</span><span className="text-xs tabular-nums text-slate-500">{role.permissions.length} permisos</span></div>
                <p className="mt-1 text-xs text-slate-500">{role.description ?? `${role.permissions.length} permisos configurados`}</p>
              </li>
            ))}
          </ul>
        </SectionCard>
      </section>
    </div>
  );
}

function ModulesTab({ detail, canManage, canOpenExpenses }: { detail: PlatformCompanyDetail; canManage: boolean; canOpenExpenses: boolean }) {
  const manageableModules = detail.modules.filter((module) => !detail.workspaceEnabled || module.key === "expenses");
  const actionsByModule = canManage
    ? Object.fromEntries(manageableModules.map((module) => [module.key, <ModuleStatusForm key={module.key} companyId={detail.header.id} moduleKey={module.key} status={module.status} canManage />]))
    : undefined;
  const expensesModule = detail.modules.find((module) => module.key === "expenses");
  const expensesActive = expensesModule?.status === "ENABLED" || expensesModule?.status === "PILOT";
  return (
    <div className="space-y-4">
      {detail.workspaceEnabled && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm leading-6 text-blue-950">
          Rendiciones ya puede agregarse de forma independiente a esta empresa. Los módulos laborales existentes continúan en modo lectura hasta completar su aislamiento multiempresa.
        </div>
      )}
      {expensesActive && canOpenExpenses && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">
          <span>Rendiciones está activo en {detail.header.name}. </span>
          <Link href={`/empresas/${detail.header.slug}/rendiciones`} className="font-semibold underline underline-offset-2 hover:no-underline">
            Abrir Rendiciones de esta empresa →
          </Link>
        </div>
      )}
      <CompanyModuleMatrix modules={detail.modules} actionsByModule={actionsByModule} />
    </div>
  );
}

function OrganizationTab({ detail, canManage }: { detail: PlatformCompanyDetail; canManage: boolean }) {
  const parents = flattenOrganization(detail.organization);
  return (
    <div className="space-y-5">
      {canManage && (
        <SectionCard title="Agregar unidad organizacional">
          <OrganizationUnitForm companyId={detail.header.id} parents={parents} canManage />
        </SectionCard>
      )}
      <OrganizationTree roots={detail.organization} />
      <p className="text-xs leading-5 text-slate-500">Esta fase administra la estructura y sus conteos agregados. Cargos, responsables y asignaciones individuales se incorporarán cuando el workspace sea tenant-aware, sin exponer identidades laborales al control plane.</p>
    </div>
  );
}

const AUDIT_ACTION_LABEL: Record<string, string> = {
  "company.created": "Empresa creada",
  "company.membership_role.assigned": "Rol de usuario actualizado",
  "company.module.status_changed": "Estado de módulo actualizado",
  "company.onboarding_step.status_changed": "Paso de onboarding actualizado",
  "company.invitation.created": "Invitación registrada",
  "company.organization_unit.created": "Unidad organizacional creada",
};

function AuditTab({ detail }: { detail: PlatformCompanyDetail }) {
  const dateFormatter = new Intl.DateTimeFormat("es-CL", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: detail.timezone,
  });
  return (
    <SectionCard title="Actividad reciente">
      {detail.audit.length === 0 ? (
        <p className="text-sm text-slate-500">Aún no hay acciones administrativas registradas para esta empresa.</p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {detail.audit.map((item) => (
            <li key={item.id} className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900">{AUDIT_ACTION_LABEL[item.action] ?? item.action}</div>
                <div className="mt-0.5 text-xs text-slate-500">{item.actorName} · {item.targetType}</div>
              </div>
              <time className="text-xs text-slate-400" dateTime={item.createdAt}>{dateFormatter.format(new Date(item.createdAt))}</time>
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
}

export default async function CompanyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<{ tab?: string | string[]; memberPage?: string | string[]; invitationPage?: string | string[] }>;
}) {
  const [{ companySlug }, query, session] = await Promise.all([params, searchParams, requirePlatformSession()]);
  const selected = activeTab(query.tab);
  const rawMemberPage = Array.isArray(query.memberPage) ? query.memberPage[0] : query.memberPage;
  const parsedMemberPage = Number.parseInt(rawMemberPage ?? "", 10);
  const memberPage = Number.isSafeInteger(parsedMemberPage) && parsedMemberPage > 0 ? parsedMemberPage : 1;
  const rawInvitationPage = Array.isArray(query.invitationPage) ? query.invitationPage[0] : query.invitationPage;
  const parsedInvitationPage = Number.parseInt(rawInvitationPage ?? "", 10);
  const invitationPage = Number.isSafeInteger(parsedInvitationPage) && parsedInvitationPage > 0 ? parsedInvitationPage : 1;
  // Un rol de plataforma NO concede acceso automático a datos de una empresa
  // (README, sección Pinned) -- así que el link a Rendiciones solo se
  // muestra cuando esta persona además tiene una membresía de empresa real
  // ahí, reusando la misma consulta que ya usa el propio módulo de
  // Rendiciones (listExpenseCompaniesFromClient) en vez de inventar un
  // chequeo paralelo. Se pide en paralelo con getPlatformCompanyDetail() --
  // solo depende de session.userId, ya resuelto -- y se tolera que falle
  // (banner opcional, nunca debe tumbar el resto de la pestaña Módulos).
  const [detailResult, expenseCompaniesResult] = await Promise.allSettled([
    getPlatformCompanyDetail(companySlug, selected, memberPage, invitationPage),
    selected === "modules"
      ? createClient().then((supabase) => listExpenseCompaniesFromClient(supabase, session.userId))
      : Promise.resolve([]),
  ]);

  if (detailResult.status === "rejected") {
    if (detailResult.reason instanceof PlatformCompanyNotFoundError) notFound();
    throw detailResult.reason;
  }
  const detail: PlatformCompanyDetail = detailResult.value;
  const expenseCompanies = expenseCompaniesResult.status === "fulfilled" ? expenseCompaniesResult.value : [];
  const canOpenExpenses = expenseCompanies.some((company) => company.slug === detail.header.slug);

  return (
    <div className="space-y-6">
      <CompanyHeader company={detail.header} backHref="/plataforma/empresas" />
      <CompanyTabs tabs={buildTabs(detail.header.slug, selected, detail)} />
      {selected === "overview" && <OverviewTab detail={detail} canManage={session.canManage} />}
      {selected === "users" && (
        <UsersTab
          detail={detail}
          canManage={session.canManage}
          canResetMfa={session.role === "OWNER"}
        />
      )}
      {selected === "modules" && <ModulesTab detail={detail} canManage={session.canManage} canOpenExpenses={canOpenExpenses} />}
      {selected === "organization" && <OrganizationTab detail={detail} canManage={session.canManage} />}
      {selected === "audit" && <AuditTab detail={detail} />}
    </div>
  );
}
