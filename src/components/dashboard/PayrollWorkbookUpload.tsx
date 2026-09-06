"use client";
import { useEffect, useState } from "react";

type ConflictChoice = "KEEP_RRHH" | "ACCEPT_WORKERA" | "THIRD_VALUE";
type PreviewConflict = { stableKey: string; employeeName: string; workDate: string | null; fieldCode: string; valueKind: "MINUTES" | "CLP" | "CODE"; sourceAtAcceptance: string | number; currentWorkeraValue: string | number; rrhhFinalValue: string | number };
type Preview = { baseVersionId: string | null; sourceRevision: number; hash: string; previewToken: string; previewIssuedAt: number; totalChanges: number; conflicts: PreviewConflict[]; changes: Array<{ sheet: string; cell: string; kind: string; previous: unknown; next: unknown; consequence: string; stableKey?: string | null; sourceValueAtComparison?: unknown; employeeName?: string | null; workDate?: string | null; fieldCode?: string | null }> };
type ConflictResolutionDraft = { choice: ConflictChoice | ""; thirdValue: string; reason: string };
type WorkbookVersion = {
  id: string;
  version_number: number;
  status: "ACCEPTED" | "CLOSED_SNAPSHOT";
  content_sha256: string;
  file_size: number;
  general_reason: string;
  accepted_at: string | null;
  closed_snapshot_at: string | null;
};

function visibleValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "vacío";
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return serialized.length > 140 ? `${serialized.slice(0, 137)}…` : serialized;
}

function changeCountLabel(count: number): string {
  return `${count} ${count === 1 ? "cambio" : "cambios"}`;
}

export function PayrollWorkbookUpload({ month, canUpload }: { month: string; canUpload: boolean }) {
  const [file, setFile] = useState<File | null>(null); const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  const [conflictResolutions, setConflictResolutions] = useState<Record<string, ConflictResolutionDraft>>({});
  const [versions, setVersions] = useState<WorkbookVersion[]>([]); const [historyNonce, setHistoryNonce] = useState(0);
  useEffect(() => {
    let active = true;
    void fetch(`/dashboard/import-asistencia?month=${encodeURIComponent(month)}`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : { versions: [] })
      .then((data) => { if (active) setVersions(Array.isArray(data.versions) ? data.versions : []); })
      .catch(() => { if (active) setVersions([]); });
    return () => { active = false; };
  }, [month, historyNonce]);
  async function submit(confirm: boolean) {
    if (!file) return; setBusy(true); setMessage("");
    const body = new FormData(); body.set("file", file); body.set("month", month); body.set("confirm", String(confirm)); body.set("reason", reason); if (preview?.baseVersionId) body.set("baseVersionId", preview.baseVersionId);
    if (preview) {
      body.set("uploadedHash", preview.hash); body.set("previewToken", preview.previewToken); body.set("previewIssuedAt", String(preview.previewIssuedAt));
      body.set("conflictResolutions", JSON.stringify(preview.conflicts.map((conflict) => {
        const draft = conflictResolutions[conflict.stableKey];
        return {
          stableKey: conflict.stableKey,
          choice: draft?.choice,
          thirdValue: draft?.choice === "THIRD_VALUE"
            ? conflict.valueKind === "CODE" ? draft.thirdValue : Number(draft.thirdValue)
            : null,
          reason: draft?.reason ?? "",
        };
      })));
    }
    const response = await fetch("/dashboard/import-asistencia", { method: "POST", body }); const data = await response.json(); setBusy(false);
    if (!response.ok) { setMessage(data.error ?? "No se pudo procesar el archivo."); return; }
    if (confirm) { setMessage(`Versión confirmada. Se conservaron ${changeCountLabel(data.totalChanges)}.`); setPreview(null); setFile(null); setHistoryNonce((value) => value + 1); }
    else {
      setPreview(data);
      setConflictResolutions(Object.fromEntries((data.conflicts ?? []).map((conflict: PreviewConflict) => [
        conflict.stableKey,
        { choice: "", thirdValue: "", reason: "" },
      ])));
    }
  }
  const conflictsReady = !preview || preview.conflicts.every((conflict) => {
    const draft = conflictResolutions[conflict.stableKey];
    return Boolean(draft?.choice && draft.reason.trim() && (draft.choice !== "THIRD_VALUE" || draft.thirdValue.trim()));
  });
  return <div className="mt-4 border-t border-slate-200 pt-4">
    {canUpload && <>
      <h3 className="text-sm font-semibold text-slate-900">Subir Excel modificado</h3>
      <p className="mt-1 text-xs text-slate-500">Primero compara. Fórmulas y formato se conservan en el archivo, pero no se ejecutan como datos contables.</p>
      <input className="mt-3 block w-full text-xs" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} />
      <button type="button" disabled={!file || busy} onClick={() => submit(false)} className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50">Comparar cambios</button>
      {preview && <div className="mt-3 rounded-md bg-amber-50 p-3 text-xs text-amber-900">
      <p>{changeCountLabel(preview.totalChanges)} {preview.totalChanges === 1 ? "detectado" : "detectados"}. Revisa hoja, celda y consecuencia antes de confirmar.</p>
      <ul className="mt-2 max-h-64 space-y-1 overflow-auto">{preview.changes.map((change, index) => <li key={`${change.sheet}-${change.cell}-${index}`} className="rounded border border-amber-200 bg-white px-2 py-1.5">
        <span className="font-semibold">{change.sheet} {change.cell}</span>: {change.kind} · {change.consequence === "AJUSTE_EMPRESARIAL" ? "ajuste reconocido" : "solo conservar archivo"}
        {(change.employeeName || change.workDate || change.fieldCode) && <span className="mt-0.5 block text-amber-800">{change.employeeName || "Cambio general"}{change.workDate ? ` · ${change.workDate}` : ""}{change.fieldCode ? ` · ${change.fieldCode}` : ""}</span>}
        <span className="mt-0.5 block break-all text-amber-800">Antes: {visibleValue(change.previous)} → Después: {visibleValue(change.next)}</span>
      </li>)}</ul>
      {preview.conflicts.length > 0 && <div className="mt-3 rounded border border-red-300 bg-red-50 p-2 text-red-900">
        <p className="font-semibold">Conflictos Workera / RR. HH. ({preview.conflicts.length})</p>
        <p className="mt-1">Debes resolver cada uno antes de confirmar. Ninguna opción se propaga sin tu elección.</p>
        <div className="mt-2 space-y-2">{preview.conflicts.map((conflict) => {
          const draft = conflictResolutions[conflict.stableKey] ?? { choice: "", thirdValue: "", reason: "" };
          return <div key={conflict.stableKey} className="rounded border border-red-200 bg-white p-2">
            <p className="font-medium">{conflict.employeeName}{conflict.workDate ? ` · ${conflict.workDate}` : ""} · {conflict.fieldCode}</p>
            <p className="mt-1">Fuente al decidir: {visibleValue(conflict.sourceAtAcceptance)} · Workera actual: {visibleValue(conflict.currentWorkeraValue)} · Valor final RR. HH.: {visibleValue(conflict.rrhhFinalValue)}</p>
            <select className="mt-2 rounded border border-red-300 p-1" value={draft.choice} onChange={(event) => setConflictResolutions((current) => ({ ...current, [conflict.stableKey]: { ...draft, choice: event.target.value as ConflictChoice | "" } }))}>
              <option value="">Seleccionar resolución…</option>
              <option value="KEEP_RRHH">Mantener RR. HH.</option>
              <option value="ACCEPT_WORKERA">Aceptar Workera</option>
              <option value="THIRD_VALUE">Ingresar tercer valor</option>
            </select>
            {draft.choice === "THIRD_VALUE" && <input className="ml-2 rounded border border-red-300 p-1" type={conflict.valueKind === "CODE" ? "text" : "number"} min={conflict.valueKind === "CODE" ? undefined : 0} step={conflict.valueKind === "CODE" ? undefined : 1} value={draft.thirdValue} onChange={(event) => setConflictResolutions((current) => ({ ...current, [conflict.stableKey]: { ...draft, thirdValue: event.target.value } }))} placeholder={conflict.valueKind === "CODE" ? "Código oficial" : "Total final"} />}
            <input className="mt-2 block w-full rounded border border-red-300 p-1" value={draft.reason} onChange={(event) => setConflictResolutions((current) => ({ ...current, [conflict.stableKey]: { ...draft, reason: event.target.value } }))} placeholder="Motivo obligatorio de la resolución" maxLength={500} />
          </div>;
        })}</div>
      </div>}
      {preview.totalChanges > preview.changes.length && <p className="mt-2 font-medium">Se muestran {preview.changes.length} de {preview.totalChanges}; descarga el registro completo antes de confirmar.</p>}
      <label className="mt-3 block font-medium">Motivo general obligatorio</label><textarea className="mt-1 w-full rounded border border-amber-300 bg-white p-2" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
      <button type="button" disabled={!reason.trim() || !conflictsReady || busy} onClick={() => submit(true)} className="mt-2 rounded-md bg-arcotex-blue px-3 py-1.5 text-sm text-white disabled:opacity-50">Confirmar nueva versión</button>
      <button type="button" disabled={busy} onClick={() => { setPreview(null); setReason(""); }} className="ml-2 mt-2 rounded-md border border-amber-400 px-3 py-1.5 text-sm disabled:opacity-50">Cancelar</button>
      </div>}
    </>}
    {message && <p className="mt-2 text-xs text-slate-700" aria-live="polite">{message}</p>}
    <div className={canUpload ? "mt-4 border-t border-slate-200 pt-3" : ""}>
      <h3 className="text-sm font-semibold text-slate-900">Historial de versiones y cierres</h3>
      {versions.length === 0
        ? <p className="mt-1 text-xs text-slate-500">No hay versiones ni snapshots para este período.</p>
        : <ul className="mt-2 space-y-1 text-xs text-slate-600">{versions.map((version) => {
          const occurredAt = version.closed_snapshot_at ?? version.accepted_at;
          const kind = version.status === "CLOSED_SNAPSHOT" ? "Snapshot de cierre" : "Versión aceptada";
          return <li key={version.id} className="flex items-center justify-between gap-2"><span>v{version.version_number} · {kind}{occurredAt ? ` · ${new Date(occurredAt).toLocaleString("es-CL")}` : ""} · {version.general_reason}</span><a className="font-medium text-arcotex-blue underline" href={`/dashboard/import-asistencia?version=${encodeURIComponent(version.id)}`}>Descargar exacta</a></li>;
        })}</ul>}
    </div>
  </div>;
}
