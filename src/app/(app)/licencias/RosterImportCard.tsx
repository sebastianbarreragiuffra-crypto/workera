"use client";

import { useActionState, useRef, useState } from "react";
import { SectionCard } from "../../../components/shell/SectionCard";
import { Badge } from "../../../components/shell/Badge";
import { previewPersonnelRosterAction, applyPersonnelRosterAction, type RosterPreviewActionState, type ApplyRosterActionState } from "./roster-actions";

const PREVIEW_INITIAL: RosterPreviewActionState = { status: "idle", message: "" };
const APPLY_INITIAL: ApplyRosterActionState = { status: "idle", message: "" };

/**
 * La reconciliación con Workera (GET /employee) sigue existiendo en el
 * backend (`runWorkeraRosterReconciliationAction`, `bootstrapEmployeesFromRoster`)
 * -- se usará en una fase futura cuando haya credenciales reales de Workera.
 * A propósito NO se expone acá: esta tarjeta solo cubre el bootstrap
 * administrativo por planilla de personal.
 *
 * Un único <form> con un único <input type="file">, y los dos botones
 * ("Ver cambios" / "Confirmar actualización de roster") apuntan a acciones
 * distintas vía `formAction` (React 19) -- ambos leen el mismo archivo
 * seleccionado. Antes había un segundo <input type="file"> oculto que se
 * llenaba clonando el archivo por DataTransfer en un useEffect: ese clon
 * dependía de que el input original SIGUIERA teniendo el archivo después de
 * que la Server Action de preview corriera, lo cual no está garantizado
 * (algunos navegadores limpian inputs de archivo de un <form> tras una
 * acción) -- y al ser un input oculto y `required`, si terminaba vacío el
 * navegador bloqueaba el submit del todo SIN mostrar ningún error visible
 * (exactamente el síntoma reportado: "Confirmar" no hacía nada). Con un
 * solo input real, ese modo de falla desaparece.
 */
export function RosterImportCard() {
  const [previewState, previewAction, previewPending] = useActionState(previewPersonnelRosterAction, PREVIEW_INITIAL);
  const [applyState, applyAction, applyPending] = useActionState(applyPersonnelRosterAction, APPLY_INITIAL);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const showPreview = previewState.status === "ready" && previewState.preview && applyState.status !== "success";
  const pending = previewPending || applyPending;

  return (
    <div className="space-y-4">
      <SectionCard title="Actualizar roster de empleados">
        <p className="text-xs text-slate-500">Sube la planilla actualizada de trabajadores para revisar cambios antes de aplicarlos.</p>

        {applyState.status !== "success" && (
          <form action={previewAction} className="mt-2 space-y-3" onSubmit={() => setSelectedFileName(fileInputRef.current?.files?.[0]?.name ?? null)}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                ref={fileInputRef}
                type="file"
                name="file"
                accept=".xls,.xlsx"
                required
                aria-label="Planilla de personal"
                className="min-w-0 flex-1 text-sm"
              />
              <button
                type="submit"
                formAction={previewAction}
                disabled={pending}
                className="shrink-0 rounded-md border border-arcotex-blue px-3 py-1.5 text-sm font-medium text-arcotex-blue hover:bg-arcotex-blue/5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {previewPending ? "Calculando vista previa..." : "Ver cambios"}
              </button>
            </div>

            {previewState.status === "blocked" && (
              <p role="alert" className="rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
                {previewState.message}
              </p>
            )}
            {previewState.status === "error" && (
              <p role="alert" className="rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
                {previewState.message}
              </p>
            )}

            {showPreview && previewState.preview && (
              <div className="space-y-3 rounded-md border border-border p-3">
                <p className="text-sm text-slate-600">
                  Vista previa de <span className="font-medium">{selectedFileName}</span> ({previewState.preview.totalInFile} trabajadores en el archivo):
                </p>
                <div className="flex flex-wrap gap-2">
                  <Badge label={`${previewState.preview.newCount} nuevos`} tone="positive" />
                  <Badge label={`${previewState.preview.updatedCount} actualizados`} tone="info" />
                  <Badge label={`${previewState.preview.unchangedCount} sin cambios`} tone="neutral" />
                  <Badge label={`${previewState.preview.reactivatedCount} reactivados`} tone="info" />
                  {previewState.preview.toDeactivateCount > 0 && <Badge label={`${previewState.preview.toDeactivateCount} se desactivarán`} tone="negative" />}
                  {previewState.preview.unassignedCount > 0 && <Badge label={`${previewState.preview.unassignedCount} sin asignar`} tone="warning" />}
                  {previewState.preview.problemCount > 0 && <Badge label={`${previewState.preview.problemCount} con problemas`} tone="negative" />}
                </div>

                {previewState.preview.toDeactivate.length > 0 && (
                  <div className="text-sm text-critical">
                    <p className="font-medium">Se desactivarán (activos hoy, ausentes en la planilla confirmada):</p>
                    <ul className="mt-1 list-disc pl-5">
                      {previewState.preview.toDeactivate.map((d) => (
                        <li key={d.employeeId}>{d.displayName}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <button
                  type="submit"
                  formAction={applyAction}
                  disabled={pending}
                  className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {applyPending ? "Aplicando..." : "Confirmar actualización de roster"}
                </button>
              </div>
            )}
          </form>
        )}

        {applyState.status === "success" && (
          <p role="status" className="mt-3 rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">
            ✓ {applyState.message}
          </p>
        )}
        {applyState.status === "error" && (
          <p role="alert" className="mt-3 rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
            {applyState.message}
          </p>
        )}
      </SectionCard>
    </div>
  );
}
