import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "../../../../lib/supabase/server";
import { getCurrentProfile } from "../../../../lib/auth/session";
import { getEmployeeDetail } from "../../../../lib/view-models/employee-detail-view";
import { todayInSantiago, formatDateLong } from "../../../../lib/view-models/date-utils";
import { AreaAccessError } from "../../../../lib/access/scope";
import { ErrorState, EmptyState } from "../../../../components/shell/StateMessages";
import { PageHeader } from "../../../../components/shell/PageHeader";
import { SectionCard } from "../../../../components/shell/SectionCard";
import { EmployeeAvatar } from "../../../../components/shell/EmployeeAvatar";
import { Badge } from "../../../../components/shell/Badge";

const AREA_LABEL: Record<"PRODUCTION" | "INSTALLATION" | "ADMINISTRATION", string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  MEDICAL_CERTIFICATE: "Comprobante médico",
  TRANSPORT_PROOF: "Comprobante de transporte",
  IDENTIFICATION: "Identificación",
  OTHER: "Otro",
};

function formatShortDate(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString("es-CL", { day: "2-digit", month: "short" });
}

export default async function EmployeeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");

  const { id } = await params;
  const supabase = await createClient();

  let detail;
  try {
    detail = await getEmployeeDetail(supabase, profile.role, id, todayInSantiago());
  } catch (error) {
    if (error instanceof AreaAccessError) {
      return <ErrorState message="No tienes acceso a este trabajador." retryHref="/empleados" />;
    }
    return <ErrorState retryHref="/empleados" />;
  }

  return (
    <div className="space-y-4">
      <Link href="/empleados" className="text-sm text-arcotex-blue hover:underline">
        ← Volver a Empleados
      </Link>

      <PageHeader
        title={detail.displayName}
        subtitle={`${AREA_LABEL[detail.areaCode]} · ${detail.active ? "Activo" : "Inactivo"}`}
        actions={
          <div className="flex items-center gap-2">
            <Link href={`/revision-diaria?fecha=${todayInSantiago()}&area=${detail.areaCode}&filtro=todos&empleado=${detail.employeeId}`} className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark">
              Revisar hoy
            </Link>
            <EmployeeAvatar displayName={detail.displayName} />
            <Badge label={detail.timeControl.kind === "EXEMPT" ? "Exento de control horario" : "Control horario normal"} tone={detail.timeControl.kind === "EXEMPT" ? "info" : "neutral"} />
          </div>
        }
      />

      <SectionCard title="Horario efectivo">
        {detail.schedule.kind === "SCHEDULED" && (
          <p className="text-sm text-slate-700">
            {detail.schedule.scheduledStart.slice(0, 5)} – {detail.schedule.scheduledEnd.slice(0, 5)}
          </p>
        )}
        {detail.schedule.kind === "DAY_OFF" && <p className="text-sm text-slate-500">Día libre hoy según horario asignado.</p>}
        {detail.schedule.kind === "EXEMPT" && <p className="text-sm text-slate-500">Trabajador exento de control horario.</p>}
        {detail.schedule.kind === "NO_SCHEDULE_ASSIGNED" && <p className="text-sm text-amber-700">Sin horario asignado.</p>}
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-3">
        <SectionCard title={`Atrasos recientes (últimos 30 días)`}>
          {detail.recentLateArrivals.length === 0 ? (
            <EmptyState message="Sin atrasos en los últimos 30 días." />
          ) : (
            <ul className="space-y-2 text-sm">
              {detail.recentLateArrivals.map((item, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span className="text-slate-600">{formatShortDate(item.workDate)} · {item.detectedMinutes} min</span>
                  {item.justified === null ? (
                    <Badge label="Pendiente" tone="warning" />
                  ) : (
                    <Badge label={item.justified ? "Justificado" : "No justificado"} tone={item.justified ? "positive" : "negative"} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Horas extra recientes (últimos 30 días)">
          {detail.recentOvertime.length === 0 ? (
            <EmptyState message="Sin horas extra en los últimos 30 días." />
          ) : (
            <ul className="space-y-2 text-sm">
              {detail.recentOvertime.map((item, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span className="text-slate-600">{formatShortDate(item.workDate)} · {item.candidateMinutes} min</span>
                  {item.decisionStatus === null ? (
                    <Badge label="Pendiente" tone="warning" />
                  ) : (
                    <Badge
                      label={item.decisionStatus === "FULLY_APPROVED" ? "Aprobado" : item.decisionStatus === "REJECTED" ? "Rechazado" : item.decisionStatus}
                      tone={item.decisionStatus === "FULLY_APPROVED" ? "positive" : item.decisionStatus === "REJECTED" ? "negative" : "neutral"}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard title="Ausencias / licencias recientes (últimos 30 días)">
          {detail.recentAbsences.length === 0 ? (
            <EmptyState message="Sin ausencias en los últimos 30 días." />
          ) : (
            <ul className="space-y-2 text-sm">
              {detail.recentAbsences.map((item, i) => (
                <li key={i} className="flex items-center justify-between">
                  <span className="text-slate-600">
                    {item.absenceTypeName} · {formatShortDate(item.startDate)}
                    {item.endDate !== item.startDate ? ` – ${formatShortDate(item.endDate)}` : ""}
                  </span>
                  {item.decisionStatus === null ? (
                    <Badge label="Pendiente" tone="warning" />
                  ) : (
                    <Badge
                      label={item.decisionStatus === "CONFIRMED" ? "Confirmado" : item.decisionStatus === "DISPUTED" ? "En disputa" : item.decisionStatus === "PENDING_DOCUMENT" ? "Documento pendiente" : item.decisionStatus}
                      tone={item.decisionStatus === "CONFIRMED" ? "positive" : item.decisionStatus === "DISPUTED" ? "negative" : "neutral"}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Documentos">
        {detail.documents.length === 0 ? (
          <EmptyState message="Sin documentos adjuntados." />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {detail.documents.map((doc) => (
              <li key={doc.id} className="flex items-center justify-between py-2">
                <div>
                  <div className="font-medium text-slate-800">{doc.originalFilename}</div>
                  <div className="text-xs text-slate-500">{DOCUMENT_TYPE_LABEL[doc.documentType] ?? doc.documentType}</div>
                </div>
                <span className="text-xs text-slate-500">{formatDateLong(doc.uploadedAt.slice(0, 10))}</span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
