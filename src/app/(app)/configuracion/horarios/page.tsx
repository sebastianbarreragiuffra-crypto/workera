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
import { resolveActiveWorkforceCompany } from "../../../../lib/tenant/active-workforce-company";
import { resolvePayrollCompanyRole } from "../../../../lib/payroll/payroll-company-role";

/**
 * Administración de horarios (MB-1). Es el prerequisito operativo de la marcha
 * blanca: mientras `schedule_assignments` esté vacía,
 * `resolveEffectiveSchedule` devuelve `NO_SCHEDULE_ASSIGNED` para todos y el
 * motor de reglas no genera ningún candidato de atraso/salida anticipada/horas
 * extra, por más que la sincronización con Workera traiga marcaciones.
 *
 * ADMIN_RRHH es la única autoridad que escribe y confirma horarios.
 * SUPER_ADMIN conserva esta vista únicamente como auditor técnico.
 */
export default async function HorariosPage() {
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
  const canManageSchedules = payrollRole === "ADMIN_RRHH";

  const today = todayInSantiago();
  const board = await getScheduleAdminBoard(supabase, today, workforceCompany.companyId);

  const coveredCount = board.totalActive - board.unassignedCount - board.exemptCount;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Horarios"
        subtitle={canManageSchedules
          ? "Define los horarios de trabajo y quién queda exento de control horario. Sin horario asignado, el motor de reglas no calcula atrasos ni horas extra."
          : "Revisa la cobertura y las confirmaciones de horarios en modo de auditoría técnica. Solo RR. HH. puede modificarlos."}
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

      {canManageSchedules ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <BulkAssignCard schedules={board.schedules} today={today} unassignedCount={board.unassignedCount} />
          <CreateScheduleCard />
        </div>
      ) : (
        <SectionCard title="Auditoría técnica de horarios">
          <p className="text-sm text-slate-600">
            Esta vista es de solo lectura para SUPER_ADMIN. La confirmación, creación y reasignación de horarios corresponde
            exclusivamente a RR. HH.
          </p>
        </SectionCard>
      )}

      <SectionCard title={`Trabajadores (${board.totalActive})`}>
        <ScheduleAdminClient
          rows={board.rows}
          schedules={board.schedules}
          today={today}
          canManage={canManageSchedules}
        />
      </SectionCard>
    </div>
  );
}
