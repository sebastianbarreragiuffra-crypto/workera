import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { createClient } from "../../../lib/supabase/server";
import { PageHeader } from "../../../components/shell/PageHeader";
import { SectionCard } from "../../../components/shell/SectionCard";
import { canApproveMedicalLicense, isPrivilegedAdmin } from "../../../lib/supabase/authorize";
import { listMedicalLicenses, computeLicenseSummary } from "../../../lib/decisions/medical-license";
import { getActiveLicenseKpiTone } from "../../../lib/decisions/medical-license-kpi";
import { getEmployeeRoster } from "../../../lib/view-models/employees-view";
import { todayInSantiago } from "../../../lib/view-models/date-utils";
import { areasVisibleToRole, type AreaCode, type CallerRole } from "../../../lib/access/scope";
import { EmployeeDirectory } from "../../../components/employees/EmployeeDirectory";
import { LicenciasDashboard, UploadLicenseCard } from "./LicenciasDashboard";
import { RosterImportCard } from "./RosterImportCard";

const KPI_TONE_CLASS: Record<"healthy" | "attention", string> = {
  healthy: "border-success-border bg-success-bg text-success",
  attention: "border-warning-border bg-warning-bg text-warning",
};

/**
 * Página consolidada: directorio de empleados ("Trabajadores", reutilizado
 * sin reconstruirlo -- ver `EmployeeDirectory`, extraído de la antigua
 * `/empleados/page.tsx`) + gestión de licencias médicas. "Trabajadores" ya
 * no es un ítem de menú separado -- `/empleados` ahora redirige acá.
 */
export default async function LicenciasPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");

  const callerRole = profile.role as CallerRole;
  const allowedAreas = areasVisibleToRole(callerRole);
  const params = await searchParams;
  const areaFilter = params.area as AreaCode | undefined;
  const search = params.q?.trim();
  const today = todayInSantiago();

  const supabase = await createClient();
  const isApprover = canApproveMedicalLicense(profile);
  const isRosterAdmin = isPrivilegedAdmin(profile.role);

  const [licenses, uploadPickerRoster, directoryRoster] = await Promise.all([
    listMedicalLicenses(supabase),
    getEmployeeRoster(supabase, callerRole, { activeOnly: true }, today),
    getEmployeeRoster(supabase, callerRole, { areaCode: areaFilter, search }, today),
  ]);

  const summary = computeLicenseSummary(licenses, today);
  const kpiTone = getActiveLicenseKpiTone(summary.activeNowCount);
  const employeeOptions = uploadPickerRoster.map((e) => ({ id: e.employeeId, displayName: e.displayName }));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Licencias"
        subtitle={isApprover ? "Directorio de empleados y licencias médicas -- sube documentos y revisa las pendientes de aprobación." : "Directorio de empleados y licencias médicas."}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard title="Licencias activas">
          <div className={`flex items-center justify-center rounded-md border px-4 py-3 ${KPI_TONE_CLASS[kpiTone]}`}>
            <span className="text-3xl font-semibold leading-none">{summary.activeNowCount}</span>
          </div>
        </SectionCard>

        <UploadLicenseCard employees={employeeOptions} />
      </div>

      {isRosterAdmin && <RosterImportCard />}

      <LicenciasDashboard isApprover={isApprover} licenses={licenses} />

      <SectionCard title={`Empleados (${directoryRoster.length})`}>
        <EmployeeDirectory roster={directoryRoster} allowedAreas={allowedAreas} areaFilter={areaFilter} search={search} baseHref="/licencias" />
      </SectionCard>
    </div>
  );
}
