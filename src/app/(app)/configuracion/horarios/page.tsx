import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../../lib/auth/session";
import { createClient } from "../../../../lib/supabase/server";
import { PageHeader } from "../../../../components/shell/PageHeader";
import { SectionCard } from "../../../../components/shell/SectionCard";
import { Badge } from "../../../../components/shell/Badge";
import { todayInSantiago } from "../../../../lib/view-models/date-utils";
import { getScheduleAdminBoard } from "../../../../lib/schedules/schedule-administration";
import { ScheduleAdminClient } from "./ScheduleAdminClient";
import { BulkAssignCard } from "./BulkAssignCard";
import { CreateScheduleCard } from "./CreateScheduleCard";

/**
 * Administración de horarios (MB-1). Es el prerequisito operativo de la marcha
 * blanca: mientras `schedule_assignments` esté vacía,
 * `resolveEffectiveSchedule` devuelve `NO_SCHEDULE_ASSIGNED` para todos y el
 * motor de reglas no genera ningún candidato de atraso/salida anticipada/horas
 * extra, por más que la sincronización con Workera traiga marcaciones.
 *
 * Privilegiada (SUPER_ADMIN/ADMIN_RRHH) porque escribe las tablas cuya RLS ya
 * es `is_privileged_admin()`. Un supervisor de área nunca define horarios.
 */
export default async function HorariosPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") redirect("/dashboard");

  const today = todayInSantiago();
  const supabase = await createClient();
  const board = await getScheduleAdminBoard(supabase, today);

  const coveredCount = board.totalActive - board.unassignedCount - board.exemptCount;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Horarios"
        subtitle="Define los horarios de trabajo y quién queda exento de control horario. Sin horario asignado, el motor de reglas no calcula atrasos ni horas extra."
      />

      <SectionCard title="Cobertura de horarios">
        <div className="flex flex-wrap items-center gap-2">
          <Badge label={`${coveredCount} con horario`} tone="positive" />
          {board.unassignedCount > 0 ? (
            <Badge label={`${board.unassignedCount} sin horario`} tone="negative" />
          ) : (
            <Badge label="Nadie sin horario" tone="positive" />
          )}
          <Badge label={`${board.exemptCount} exentos`} tone="info" />
          <Badge label={`${board.totalActive} activos`} tone="neutral" />
        </div>
        {board.unassignedCount > 0 && (
          <p className="mt-2 text-xs text-critical">
            Los trabajadores sin horario quedan invisibles para el motor de reglas: no se les detecta atraso, salida anticipada ni horas
            extra. Asígnales uno antes de empezar la marcha blanca.
          </p>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BulkAssignCard schedules={board.schedules} today={today} unassignedCount={board.unassignedCount} />
        <CreateScheduleCard />
      </div>

      <SectionCard title={`Trabajadores (${board.totalActive})`}>
        <ScheduleAdminClient rows={board.rows} schedules={board.schedules} today={today} />
      </SectionCard>
    </div>
  );
}
