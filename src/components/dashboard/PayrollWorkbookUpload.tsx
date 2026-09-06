"use client";
import { useState } from "react";

type Preview = { baseVersionId: string | null; totalChanges: number; changes: Array<{ sheet: string; cell: string; kind: string; previous: unknown; next: unknown; consequence: string }> };

export function PayrollWorkbookUpload({ month }: { month: string }) {
  const [file, setFile] = useState<File | null>(null); const [preview, setPreview] = useState<Preview | null>(null);
  const [reason, setReason] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(confirm: boolean) {
    if (!file) return; setBusy(true); setMessage("");
    const body = new FormData(); body.set("file", file); body.set("month", month); body.set("confirm", String(confirm)); body.set("reason", reason); if (preview?.baseVersionId) body.set("baseVersionId", preview.baseVersionId);
    const response = await fetch("/dashboard/import-asistencia", { method: "POST", body }); const data = await response.json(); setBusy(false);
    if (!response.ok) { setMessage(data.error ?? "No se pudo procesar el archivo."); return; }
    if (confirm) { setMessage(`Versión confirmada. Se conservaron ${data.totalChanges} cambio(s).`); setPreview(null); setFile(null); }
    else setPreview(data);
  }
  return <div className="mt-4 border-t border-slate-200 pt-4">
    <h3 className="text-sm font-semibold text-slate-900">Subir Excel modificado</h3>
    <p className="mt-1 text-xs text-slate-500">Primero compara. Fórmulas y formato se conservan en el archivo, pero no se ejecutan como datos contables.</p>
    <input className="mt-3 block w-full text-xs" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => { setFile(event.target.files?.[0] ?? null); setPreview(null); }} />
    <button type="button" disabled={!file || busy} onClick={() => submit(false)} className="mt-2 rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50">Comparar cambios</button>
    {preview && <div className="mt-3 rounded-md bg-amber-50 p-3 text-xs text-amber-900">
      <p>{preview.totalChanges} cambio(s) detectado(s). Revisa hoja, celda y consecuencia antes de confirmar.</p>
      <ul className="mt-2 max-h-36 overflow-auto">{preview.changes.slice(0, 20).map((change, index) => <li key={`${change.sheet}-${change.cell}-${index}`}>{change.sheet} {change.cell}: {change.kind} · {change.consequence === "AJUSTE_EMPRESARIAL" ? "ajuste reconocido" : "solo conservar archivo"}</li>)}</ul>
      <label className="mt-3 block font-medium">Motivo general obligatorio</label><textarea className="mt-1 w-full rounded border border-amber-300 bg-white p-2" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} />
      <button type="button" disabled={!reason.trim() || busy} onClick={() => submit(true)} className="mt-2 rounded-md bg-arcotex-blue px-3 py-1.5 text-sm text-white disabled:opacity-50">Confirmar nueva versión</button>
    </div>}
    {message && <p className="mt-2 text-xs text-slate-700" aria-live="polite">{message}</p>}
  </div>;
}
