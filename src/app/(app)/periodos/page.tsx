import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { isPrivilegedAdmin } from "../../../lib/supabase/authorize";
import { createClient } from "../../../lib/supabase/server";
import { PageHeader } from "../../../components/shell/PageHeader";
import { getReportingPeriodsBoard } from "../../../lib/periods/reporting-periods";
import { PeriodsClient } from "./PeriodsClient";

/**
 * Períodos de pago (MB-7). El ciclo de la empresa es 16-al-15 (confirmado
 * contra la planilla real). Cerrar un período bloquea las correcciones de
 * marcación de esas fechas -- ese es el efecto operacional real, vía el
 * trigger `prevent_attendance_correction_on_closed_period`.
 */
export default async function ReportingPeriodsPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (!isPrivilegedAdmin(profile.role)) redirect("/dashboard");

  const supabase = await createClient();
  const board = await getReportingPeriodsBoard(supabase);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Períodos de pago"
        subtitle="Crea el ciclo del 16 al 15, síguelo hasta cerrarlo, y reábrelo con motivo si hace falta."
      />
      <PeriodsClient periods={board.periods} suggestedNext={board.suggestedNext} />
    </div>
  );
}
