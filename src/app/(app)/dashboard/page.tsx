import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { getDashboardForRole } from "../../../lib/view-models/dashboard-view";
import { getAttendanceReadiness } from "../../../lib/view-models/attendance-readiness";
import { todayInSantiago, formatDateLong } from "../../../lib/view-models/date-utils";
import { ErrorState } from "../../../components/shell/StateMessages";
import { WorkeraSyncStatus } from "../../../components/shell/WorkeraSyncStatus";
import { KpiRow } from "../../../components/dashboard/KpiRow";
import { PriorityQueueCard } from "../../../components/dashboard/PriorityQueueCard";
import { ReviewQueueCard } from "../../../components/dashboard/ReviewQueueCard";
import { UpcomingEventsCard } from "../../../components/dashboard/UpcomingEventsCard";
import { WeekSummaryCard } from "../../../components/dashboard/WeekSummaryCard";
import { DescargarAsistenciaCard } from "../../../components/dashboard/DescargarAsistenciaCard";
import { AttendanceReadinessCard } from "../../../components/dashboard/AttendanceReadinessCard";

const AREA_LABEL: Record<"PRODUCTION" | "INSTALLATION" | "ADMINISTRATION", string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

export default async function DashboardPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");

  const date = todayInSantiago();
  const supabase = await createClient();

  let dashboard;
  let readiness;
  try {
    [dashboard, readiness] = await Promise.all([
      getDashboardForRole(supabase, profile.role, date),
      getAttendanceReadiness(supabase, profile.role),
    ]);
  } catch {
    return <ErrorState retryHref="/dashboard" />;
  }

  const firstName = profile.display_name.split(" ")[0];
  const month = Number(date.split("-")[1]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">
          Buenos días, {firstName}
          {dashboard.kind === "SUPERVISOR" && <span className="ml-2 text-base font-normal text-slate-400">{AREA_LABEL[dashboard.areaCode]}</span>}
        </h1>
        <p className="text-sm text-slate-500">Resumen operacional — {formatDateLong(date)}</p>
      </div>

      <KpiRow kpis={dashboard.kpis} date={date} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DescargarAsistenciaCard />
        <AttendanceReadinessCard readiness={readiness} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <PriorityQueueCard items={dashboard.priorityQueue} date={date} />
        <ReviewQueueCard people={dashboard.reviewQueue} />
        <UpcomingEventsCard events={dashboard.upcomingEvents} monthLabel={month} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <WeekSummaryCard summary={dashboard.weekSummary} />
        {dashboard.kind === "ADMIN" && <WorkeraSyncStatus health={dashboard.syncHealth} />}
      </div>
    </div>
  );
}
