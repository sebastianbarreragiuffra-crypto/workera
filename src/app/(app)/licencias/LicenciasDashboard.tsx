"use client";

import { useActionState, useState } from "react";
import { formatCalendarDate } from "../../../lib/view-models/date-utils";
import { SectionCard } from "../../../components/shell/SectionCard";
import { Badge } from "../../../components/shell/Badge";
import {
  uploadMedicalLicenseAction,
  approveMedicalLicenseAction,
  rejectMedicalLicenseAction,
  type UploadMedicalLicenseActionState,
  type ApproveMedicalLicenseActionState,
  type RejectMedicalLicenseActionState,
} from "./actions";
import type { MedicalLicenseListItem } from "../../../lib/decisions/medical-license";

const UPLOAD_INITIAL: UploadMedicalLicenseActionState = { status: "idle", message: "", extractionStatus: null };
const APPROVE_INITIAL: ApproveMedicalLicenseActionState = { status: "idle", message: "" };
const REJECT_INITIAL: RejectMedicalLicenseActionState = { status: "idle", message: "" };

const AREA_LABEL: Record<string, string> = { PRODUCTION: "Producción", INSTALLATION: "Instalación", ADMINISTRATION: "Administración" };

const STATUS_LABEL: Record<MedicalLicenseListItem["status"], string> = {
  PENDING_RRHH_APPROVAL: "Pendiente de aprobación RRHH",
  APPROVED: "Aprobada",
  REJECTED: "Rechazada",
};

function daysBetween(start: string, end: string): number {
  const ms = new Date(`${end}T00:00:00`).getTime() - new Date(`${start}T00:00:00`).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
}

function formatDate(date: string): string {
  return formatCalendarDate(date);
}

/**
 * Compacta: sin fechas manuales -- el documento es la fuente (ver
 * `uploadMedicalLicenseAction`, que llama a `extractMedicalLicenseDates`).
 * Exportada para que `page.tsx` la ubique junto a la tarjeta KPI en la fila
 * superior.
 */
export function UploadLicenseCard({ employees }: { employees: { id: string; displayName: string }[] }) {
  const [state, formAction, pending] = useActionState(uploadMedicalLicenseAction, UPLOAD_INITIAL);

  return (
    <SectionCard title="Subir licencia médica">
      <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap">
        <select name="employeeId" required defaultValue="" className="min-w-0 flex-1 rounded-md border border-border px-3 py-1.5 text-sm">
          <option value="" disabled>
            Selecciona un trabajador
          </option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.displayName}
            </option>
          ))}
        </select>
        <input
          type="file"
          name="file"
          accept=".pdf,.jpg,.jpeg,.png"
          required
          aria-label="Documento de la licencia"
          className="min-w-0 flex-1 rounded-md border border-arcotex-copper-border bg-arcotex-copper-light p-1.5 text-xs text-slate-600 file:mr-2 file:cursor-pointer file:rounded-md file:border-0 file:bg-arcotex-copper file:px-2.5 file:py-1 file:text-xs file:font-semibold file:text-white hover:file:bg-arcotex-copper-dark"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md bg-arcotex-copper px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-arcotex-copper-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Subiendo..." : "Subir licencia"}
        </button>
      </form>
      <p className="mt-2 text-xs text-slate-500">Las fechas se detectan del documento -- RRHH las revisa y confirma al aprobar.</p>
      {state.status === "success" && (
        <p role="status" className="mt-2 rounded-md border border-success-border bg-success-bg px-3 py-2 text-xs text-success">
          ✓ {state.message}
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="mt-2 rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-xs text-critical">
          {state.message}
        </p>
      )}
    </SectionCard>
  );
}

function ApprovalPanel({ license, onDone }: { license: MedicalLicenseListItem; onDone: () => void }) {
  const [approveState, approveAction, approvePending] = useActionState(approveMedicalLicenseAction, APPROVE_INITIAL);
  const [rejectState, rejectAction, rejectPending] = useActionState(rejectMedicalLicenseAction, REJECT_INITIAL);
  const [mode, setMode] = useState<"summary" | "reject">("summary");
  const [confirmedStart, setConfirmedStart] = useState(license.proposedStartDate);
  const [confirmedEnd, setConfirmedEnd] = useState(license.proposedEndDate);

  const done = approveState.status === "success" || rejectState.status === "success";

  return (
    <SectionCard title={`Revisar licencia -- ${license.employeeName}`}>
      {license.extractionStatus === "REQUIERE_REVISION" && (
        <p role="alert" className="mb-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning">
          No se pudieron leer las fechas del documento con confianza -- verifica el documento y corrige el rango antes de aprobar.
        </p>
      )}
      <div className="space-y-1 text-sm text-slate-600">
        <p>
          Área: <span className="font-medium text-slate-800">{license.areaCode ? AREA_LABEL[license.areaCode] : "—"}</span>
        </p>
        <p>
          Subido por {license.uploadedByName} el {formatDate(license.uploadedAt.slice(0, 10))}
        </p>
        <a
          href={`/licencias/documento/${license.documentId}`}
          rel="noreferrer"
          className="inline-block rounded-md border border-arcotex-blue px-3 py-1.5 text-sm font-medium text-arcotex-blue hover:bg-arcotex-blue/5"
        >
          Descargar documento
        </a>
      </div>

      {done ? (
        <p role="status" className="mt-3 rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">
          ✓ {approveState.status === "success" ? approveState.message : rejectState.message}
        </p>
      ) : mode === "summary" ? (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <label className="text-xs text-slate-500">
              Inicio (propuesto: {formatDate(license.proposedStartDate)})
              <input
                type="date"
                value={confirmedStart}
                onChange={(e) => setConfirmedStart(e.target.value)}
                className="mt-0.5 block w-full rounded-md border border-border px-3 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-slate-500">
              Término (propuesto: {formatDate(license.proposedEndDate)})
              <input
                type="date"
                value={confirmedEnd}
                onChange={(e) => setConfirmedEnd(e.target.value)}
                className="mt-0.5 block w-full rounded-md border border-border px-3 py-1.5 text-sm"
              />
            </label>
          </div>
          <div className="rounded-md border border-border bg-slate-50 p-3 text-sm">
            <p className="font-medium text-slate-800">Confirmar aprobación</p>
            <p>Trabajador: {license.employeeName}</p>
            <p>Inicio: {formatDate(confirmedStart)}</p>
            <p>Término: {formatDate(confirmedEnd)}</p>
            <p>Días: {confirmedEnd >= confirmedStart ? daysBetween(confirmedStart, confirmedEnd) : "—"}</p>
            <p>Documento: disponible</p>
          </div>
          <form action={approveAction} className="flex gap-2">
            <input type="hidden" name="approvalId" value={license.approvalId} />
            <input type="hidden" name="confirmedStartDate" value={confirmedStart} />
            <input type="hidden" name="confirmedEndDate" value={confirmedEnd} />
            <button
              type="submit"
              disabled={approvePending}
              className="rounded-md bg-success px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {approvePending ? "Aprobando..." : "Confirmar aprobación"}
            </button>
            <button
              type="button"
              onClick={() => setMode("reject")}
              className="rounded-md border border-critical px-3 py-1.5 text-sm font-medium text-critical hover:bg-critical-bg"
            >
              Rechazar
            </button>
          </form>
          {approveState.status === "error" && (
            <p role="alert" className="rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
              {approveState.message}
            </p>
          )}
        </div>
      ) : (
        <form action={rejectAction} className="mt-3 space-y-2">
          <input type="hidden" name="approvalId" value={license.approvalId} />
          <label className="block text-xs text-slate-500">
            Motivo del rechazo
            <textarea
              name="reason"
              required
              rows={3}
              className="mt-0.5 block w-full rounded-md border border-border px-3 py-1.5 text-sm"
              placeholder="Ej. Certificado ilegible, no se puede verificar el período"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={rejectPending}
              className="rounded-md bg-critical px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {rejectPending ? "Rechazando..." : "Confirmar rechazo"}
            </button>
            <button type="button" onClick={() => setMode("summary")} className="rounded-md border border-border px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
              Cancelar
            </button>
          </div>
          {rejectState.status === "error" && (
            <p role="alert" className="rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
              {rejectState.message}
            </p>
          )}
        </form>
      )}

      {done && (
        <button type="button" onClick={onDone} className="mt-3 rounded-md border border-border px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
          Ver siguiente pendiente →
        </button>
      )}
    </SectionCard>
  );
}

function PendingApprovalsCard({ pending }: { pending: MedicalLicenseListItem[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(pending[0]?.approvalId ?? null);
  const selected = pending.find((l) => l.approvalId === selectedId) ?? pending[0] ?? null;

  function selectNext(currentId: string) {
    const idx = pending.findIndex((l) => l.approvalId === currentId);
    const next = pending[idx + 1] ?? pending[0] ?? null;
    setSelectedId(next?.approvalId ?? null);
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title="Licencias pendientes de aprobación" actions={<Badge label={`Pendientes: ${pending.length}`} tone={pending.length > 0 ? "warning" : "neutral"} />}>
        {pending.length === 0 ? (
          <p className="text-sm text-slate-500">No hay licencias pendientes de aprobación.</p>
        ) : (
          <ul className="space-y-1">
            {pending.map((l) => (
              <li key={l.approvalId}>
                <button
                  type="button"
                  onClick={() => setSelectedId(l.approvalId)}
                  className={`block w-full rounded-md px-3 py-2 text-left text-sm ${
                    l.approvalId === selected?.approvalId ? "bg-arcotex-navy text-white" : "bg-slate-50 text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {l.employeeName}
                    {l.extractionStatus === "REQUIERE_REVISION" && <Badge label="Requiere revisión" tone="warning" />}
                  </div>
                  <div className={l.approvalId === selected?.approvalId ? "text-slate-200" : "text-slate-500"}>
                    {formatDate(l.proposedStartDate)} – {formatDate(l.proposedEndDate)} · {daysBetween(l.proposedStartDate, l.proposedEndDate)} días
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {selected && <ApprovalPanel key={selected.approvalId} license={selected} onDone={() => selectNext(selected.approvalId)} />}
    </div>
  );
}

function LicenseStatusList({ licenses }: { licenses: MedicalLicenseListItem[] }) {
  if (licenses.length === 0) {
    return (
      <SectionCard title="Licencias">
        <p className="text-sm text-slate-500">No hay licencias registradas.</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Licencias">
      <ul className="divide-y divide-border">
        {licenses.map((l) => (
          <li key={l.approvalId} className="py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium text-slate-800">{l.employeeName}</p>
                <p className="text-slate-500">
                  {formatDate(l.proposedStartDate)} – {formatDate(l.proposedEndDate)} · {daysBetween(l.proposedStartDate, l.proposedEndDate)} días
                </p>
              </div>
              <Badge
                label={STATUS_LABEL[l.status]}
                tone={l.status === "APPROVED" ? "positive" : l.status === "REJECTED" ? "negative" : "warning"}
              />
            </div>
            {l.status === "REJECTED" && l.rejectionReason && <p className="mt-1 text-critical">Motivo: {l.rejectionReason}</p>}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

export function LicenciasDashboard({
  isApprover,
  licenses,
}: {
  isApprover: boolean;
  licenses: MedicalLicenseListItem[];
}) {
  const pending = licenses.filter((l) => l.status === "PENDING_RRHH_APPROVAL");
  const others = licenses.filter((l) => !isApprover || l.status !== "PENDING_RRHH_APPROVAL");

  return (
    <div className="space-y-4">
      {isApprover && <PendingApprovalsCard pending={pending} />}
      <LicenseStatusList licenses={others} />
    </div>
  );
}
