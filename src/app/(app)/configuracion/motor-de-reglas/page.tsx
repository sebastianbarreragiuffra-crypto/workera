import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../../lib/auth/session";
import { createClient } from "../../../../lib/supabase/server";
import { PageHeader } from "../../../../components/shell/PageHeader";
import { SectionCard } from "../../../../components/shell/SectionCard";
import { Badge, type BadgeTone } from "../../../../components/shell/Badge";
import { todayInSantiago, previousDate, formatDateTimeInSantiago } from "../../../../lib/view-models/date-utils";
import { ProcessDayCard } from "./ProcessDayCard";

const STATUS_TONE: Record<string, BadgeTone> = {
  SUCCEEDED: "positive",
  PARTIAL: "warning",
  FAILED: "negative",
  RUNNING: "info",
};

/**
 * Motor de reglas (MB-2). El cron lo dispara solo tras cada sincronización;
 * esta pantalla existe para reprocesar una fecha puntual -- típicamente
 * después de corregir una marcación o de asignar un horario que faltaba.
 */
export default async function MotorDeReglasPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") redirect("/dashboard");

  const supabase = await createClient();
  const { data: runs } = await supabase
    .from("rule_engine_runs")
    .select(
      "id, work_date, status, triggered_by, started_at, finished_at, employees_processed, late_candidates, early_departure_candidates, overtime_candidates, without_schedule, failure_count, error_summary"
    )
    .order("started_at", { ascending: false })
    .limit(15);

  // El cron sincroniza D-1, así que esa es la fecha que casi siempre se quiere
  // reprocesar a mano.
  const defaultDate = previousDate(todayInSantiago());

  return (
    <div className="space-y-4">
      <PageHeader
        title="Motor de reglas"
        subtitle="Procesa las marcaciones sincronizadas y genera los candidatos que revisan los supervisores en Pendientes."
      />

      <ProcessDayCard defaultDate={defaultDate} />

      <SectionCard title="Últimas corridas">
        {!runs || runs.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">
            Todavía no se ha procesado ningún día. Mientras no haya corridas, la cola de Pendientes muestra a todos como &ldquo;Sin
            novedades&rdquo;.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-2 font-semibold">Fecha</th>
                  <th className="px-2 py-2 font-semibold">Estado</th>
                  <th className="px-2 py-2 font-semibold">Origen</th>
                  <th className="px-2 py-2 text-right font-semibold">Trabajadores</th>
                  <th className="px-2 py-2 text-right font-semibold">Atrasos</th>
                  <th className="px-2 py-2 text-right font-semibold">Salidas ant.</th>
                  <th className="px-2 py-2 text-right font-semibold">Horas extra</th>
                  <th className="px-2 py-2 text-right font-semibold">Sin horario</th>
                  <th className="px-2 py-2 font-semibold">Ejecutada</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-border/60">
                    <td className="px-2 py-2 font-medium text-slate-900">{run.work_date}</td>
                    <td className="px-2 py-2">
                      <Badge label={run.status} tone={STATUS_TONE[run.status] ?? "neutral"} />
                    </td>
                    <td className="px-2 py-2 text-slate-600">{run.triggered_by === "CRON" ? "Automática" : "Manual"}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{run.employees_processed}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{run.late_candidates}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{run.early_departure_candidates}</td>
                    <td className="px-2 py-2 text-right text-slate-700">{run.overtime_candidates}</td>
                    <td className={`px-2 py-2 text-right ${run.without_schedule > 0 ? "font-semibold text-critical" : "text-slate-400"}`}>
                      {run.without_schedule}
                    </td>
                    <td className="px-2 py-2 text-xs text-slate-500">{formatDateTimeInSantiago(run.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {runs?.some((r) => r.error_summary) && (
          <div className="mt-3 space-y-1">
            {runs
              .filter((r) => r.error_summary)
              .map((r) => (
                <p key={`${r.id}-err`} className="text-xs text-critical">
                  <span className="font-medium">{r.work_date}:</span> {r.error_summary}
                </p>
              ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
