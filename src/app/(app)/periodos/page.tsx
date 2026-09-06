import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { createClient } from "../../../lib/supabase/server";
import { PageHeader } from "../../../components/shell/PageHeader";
import { getReportingPeriodsBoard } from "../../../lib/periods/reporting-periods";
import { PeriodsClient } from "./PeriodsClient";
import { resolvePayrollCompanyRole } from "../../../lib/payroll/payroll-company-role";
import { resolveActiveWorkforceCompany } from "../../../lib/tenant/active-workforce-company";

/**
 * Períodos de pago (MB-7). El ciclo de la empresa es 16-al-15 (confirmado
 * contra la planilla real). Cerrar un período bloquea las correcciones de
 * marcación de esas fechas -- ese es el efecto operacional real, vía el
 * trigger `prevent_attendance_correction_on_closed_period`.
 */
export default async function ReportingPeriodsPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  const supabase = await createClient();
  const workforceCompany = await resolveActiveWorkforceCompany(supabase);
  if (!workforceCompany) redirect("/empresas");
  const payrollRole = await resolvePayrollCompanyRole(
    supabase,
    workforceCompany.companyId,
    ["ADMIN_RRHH", "SUPER_ADMIN"],
  );
  if (!payrollRole) redirect("/dashboard");
  const board = await getReportingPeriodsBoard(supabase, workforceCompany.companyId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Períodos de pago"
        subtitle="Crea el ciclo del 16 al 15, síguelo hasta cerrarlo, y reábrelo con motivo si hace falta."
      />
      <PeriodsClient
        periods={board.periods}
        suggestedNext={board.suggestedNext}
        canManage={payrollRole === "ADMIN_RRHH"}
      />
    </div>
  );
}
