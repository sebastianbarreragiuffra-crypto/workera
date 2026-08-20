"use client";

import { useState } from "react";
import type { EmployeeRosterEntry } from "../../../lib/view-models/employees-view";
import type { PendingDocumentRelation } from "../../../lib/view-models/documents-view";
import { uploadGeneralDocumentAction } from "./actions";

const DOCUMENT_TYPES = [
  ["MEDICAL_CERTIFICATE", "Comprobante médico"],
  ["TRANSPORT_PROOF", "Comprobante de transporte"],
  ["IDENTIFICATION", "Identificación"],
  ["OTHER", "Otro"],
] as const;

export function DocumentUploadForm({ roster, pendingRelations }: { roster: EmployeeRosterEntry[]; pendingRelations: PendingDocumentRelation[] }) {
  const [employeeId, setEmployeeId] = useState("");
  const employeeRelations = pendingRelations.filter((relation) => relation.employeeId === employeeId);

  return (
    <form action={uploadGeneralDocumentAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="employeeId" className="text-xs font-medium text-slate-500">Trabajador</label>
        <select id="employeeId" name="employeeId" required value={employeeId} onChange={(event) => setEmployeeId(event.target.value)} className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm">
          <option value="">Selecciona…</option>
          {roster.map((employee) => <option key={employee.employeeId} value={employee.employeeId}>{employee.displayName}</option>)}
        </select>
      </div>
      <div>
        <label htmlFor="documentType" className="text-xs font-medium text-slate-500">Tipo</label>
        <select id="documentType" name="documentType" required className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm">
          {DOCUMENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {employeeRelations.length > 0 && (
        <div>
          <label htmlFor="relation" className="text-xs font-medium text-slate-500">Caso pendiente</label>
          <select key={employeeId} id="relation" name="relation" defaultValue={employeeRelations.length === 1 ? `${employeeRelations[0].kind}:${employeeRelations[0].recordId}` : ""} className="mt-1 block rounded-md border border-info-border bg-info-bg px-2 py-1.5 text-sm text-info">
            <option value="">Sin vincular</option>
            {employeeRelations.map((relation) => <option key={`${relation.kind}:${relation.recordId}`} value={`${relation.kind}:${relation.recordId}`}>{relation.label}</option>)}
          </select>
        </div>
      )}
      <div>
        <label htmlFor="file" className="text-xs font-medium text-slate-500">Archivo</label>
        <input id="file" type="file" name="file" required className="mt-1 block text-sm" />
      </div>
      <button type="submit" className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark">Adjuntar</button>
    </form>
  );
}
