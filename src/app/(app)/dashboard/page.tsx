import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { getDashboardForRole } from "../../../lib/view-models/dashboard-view";
import { todayInSantiago, formatDateLong } from "../../../lib/view-models/date-utils";
import { ErrorState } from "../../../components/shell/StateMessages";
import { WorkeraSyncStatus } from "../../../components/shell/WorkeraSyncStatus";
import { categoryLabel } from "../../../lib/view-models/daily-review-view";
import type { AttentionCounts } from "../../../lib/view-models/dashboard-view";

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="text-2xl font-semibold text-slate-900">{value}</div>
      <div className="text-sm text-slate-500">{label}</div>
    </div>
  );
}

function AttentionList({ attention }: { attention: AttentionCounts }) {
  const items = [
    { label: `${categoryLabel("LICENSE_DOCUMENT_REQUIRED")} (${attention.licenseDocumentPending})`, count: attention.licenseDocumentPending },
    { label: `${categoryLabel("MEDICAL_DOCUMENT_REQUIRED")} (${attention.medicalDocumentPending})`, count: attention.medicalDocumentPending },
    { label: `Horas extra pendientes (${attention.overtimePending})`, count: attention.overtimePending },
    { label: `Atrasos pendientes de revisión (${attention.lateArrivalPending})`, count: attention.lateArrivalPending },
  ].filter((item) => item.count > 0);

  if (items.length === 0) {
    return <p className="text-sm text-slate-500">✓ Sin pendientes que requieran atención hoy.</p>;
  }

  return (
    <ul className="space-y-1.5 text-sm text-slate-700">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <span aria-hidden="true" className="text-amber-500">
            ⚠
          </span>
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export default async function DashboardPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");

  const date = todayInSantiago();
  const supabase = await createClient();

  let dashboard;
  try {
    dashboard = await getDashboardForRole(supabase, profile.role, date);
  } catch {
    return <ErrorState retryHref="/dashboard" />;
  }

  const firstName = profile.display_name.split(" ")[0];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Buenos días, {firstName}</h1>
        <p className="text-sm text-slate-500">Resumen operacional — {formatDateLong(date)}</p>
      </div>

      {dashboard.kind === "SUPERVISOR" ? (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-2">
            <StatTile label="Requieren revisión" value={dashboard.requiresReview} />
            <StatTile label="Sin novedades" value={dashboard.noIssues} />
          </div>
          {dashboard.requiresReview === 0 ? (
            <EmptyToday />
          ) : (
            <p className="text-sm text-slate-600">
              Hay {dashboard.requiresReview} trabajador{dashboard.requiresReview === 1 ? "" : "es"} que requieren revisión hoy.
            </p>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile label="Presentes" value={dashboard.presentToday} />
            <StatTile label="Atrasos" value={dashboard.lateToday} />
            <StatTile label="Ausencias" value={dashboard.absentToday} />
            <StatTile label="OT pendientes" value={dashboard.overtimePendingToday} />
          </div>

          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">Atención requerida</h2>
            <div className="mt-3">
              <AttentionList attention={dashboard.attention} />
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-slate-900">Actividad por área</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {dashboard.areaActivity.map((area) => (
                <li key={area.areaCode} className="flex items-center justify-between border-b border-slate-100 pb-2 last:border-0 last:pb-0">
                  <span className="text-slate-700">{areaLabel(area.areaCode)}</span>
                  <span className="text-slate-500">
                    {area.requiresReview} requieren revisión · {area.noIssues} sin novedades
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <WorkeraSyncStatus health={dashboard.syncHealth} />
        </>
      )}
    </div>
  );
}

function EmptyToday() {
  return <p className="text-sm text-slate-500">✓ No hay revisiones pendientes para hoy.</p>;
}

function areaLabel(code: "PRODUCTION" | "INSTALLATION" | "ADMINISTRATION"): string {
  switch (code) {
    case "PRODUCTION":
      return "Producción";
    case "INSTALLATION":
      return "Instalación";
    case "ADMINISTRATION":
      return "Administración";
  }
}
