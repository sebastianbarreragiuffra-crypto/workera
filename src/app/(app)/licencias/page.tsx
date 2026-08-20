import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { createClient } from "../../../lib/supabase/server";
import { PageHeader } from "../../../components/shell/PageHeader";
import { SectionCard } from "../../../components/shell/SectionCard";
import { Badge } from "../../../components/shell/Badge";
import { canApproveMedicalLicense } from "../../../lib/supabase/authorize";
import { listMedicalLicenses, computeLicenseSummary } from "../../../lib/decisions/medical-license";
import { getEmployeeRoster } from "../../../lib/view-models/employees-view";
import { todayInSantiago } from "../../../lib/view-models/date-utils";
import { areasVisibleToRole, type AreaCode, type CallerRole } from "../../../lib/access/scope";
import { EmployeeDirectory } from "../../../components/employees/EmployeeDirectory";
import { LicenciasDashboard } from "./LicenciasDashboard";
import { RosterImportCard } from "./RosterImportCard";

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
  const isRosterAdmin = profile.role === "SUPER_ADMIN" || profile.role === "ADMIN_RRHH";

  const [licenses, uploadPickerRoster, directoryRoster] = await Promise.all([
    listMedicalLicenses(supabase),
    getEmployeeRoster(supabase, callerRole, { activeOnly: true }, today),
    getEmployeeRoster(supabase, callerRole, { areaCode: areaFilter, search }, today),
  ]);

  const summary = computeLicenseSummary(licenses, today);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Licencias"
        subtitle={isApprover ? "Directorio de empleados y licencias médicas -- sube documentos y revisa las pendientes de aprobación." : "Directorio de empleados y licencias médicas."}
      />

      <SectionCard title="Licencias activas">
        {!summary.hasAnyLicense ? (
          <p className="text-sm text-slate-500">Sin licencias activas.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Badge label={`${summary.activeNowCount} activas hoy`} tone={summary.activeNowCount > 0 ? "positive" : "neutral"} />
            <Badge label={`${summary.pendingCount} pendientes de aprobación RRHH`} tone={summary.pendingCount > 0 ? "warning" : "neutral"} />
            <Badge label={`${summary.approvedCount} aprobadas (total)`} tone="info" />
            <Badge label={`${summary.rejectedCount} rechazadas (total)`} tone={summary.rejectedCount > 0 ? "negative" : "neutral"} />
          </div>
        )}
      </SectionCard>

      {isRosterAdmin && <RosterImportCard />}

      <LicenciasDashboard
        isApprover={isApprover}
        licenses={licenses}
        employees={uploadPickerRoster.map((e) => ({ id: e.employeeId, displayName: e.displayName }))}
      />

      <SectionCard title={`Empleados (${directoryRoster.length})`}>
        <EmployeeDirectory roster={directoryRoster} allowedAreas={allowedAreas} areaFilter={areaFilter} search={search} baseHref="/licencias" />
      </SectionCard>
    </div>
  );
}
