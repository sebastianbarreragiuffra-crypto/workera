"use client";

import { useActionState } from "react";
import { SectionCard } from "../../../components/shell/SectionCard";
import { Badge } from "../../../components/shell/Badge";
import { uploadSuppliersAction, generatePayrollBatchAction, type UploadSuppliersActionState, type GenerateBatchActionState } from "./actions";

interface RecentBatch {
  id: string;
  source_filename: string;
  generated_at: string;
  matched_count: number;
  unmatched_count: number;
  total_amount: number;
}

const UPLOAD_SUPPLIERS_INITIAL: UploadSuppliersActionState = { status: "idle", message: "" };
const GENERATE_BATCH_INITIAL: GenerateBatchActionState = { status: "idle", message: "" };

function formatCLP(amount: number): string {
  return amount.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
}

export function NominaDashboard({ suppliersCount, recentBatches }: { suppliersCount: number; recentBatches: RecentBatch[] }) {
  const [suppliersState, suppliersFormAction, suppliersPending] = useActionState(uploadSuppliersAction, UPLOAD_SUPPLIERS_INITIAL);
  const [batchState, batchFormAction, batchPending] = useActionState(generatePayrollBatchAction, GENERATE_BATCH_INITIAL);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title="Maestro de proveedores" actions={<Badge label={`${suppliersCount} activos`} tone="info" />}>
        <p className="text-sm text-slate-600">
          Sube el listado de proveedores (Rut, Nombre Beneficiario, FP, BCO, N° Cuenta Cte.) para actualizar los datos
          bancarios usados al generar la nómina. Un proveedor con el mismo nombre se actualiza; nunca se duplica.
        </p>
        <form action={suppliersFormAction} encType="multipart/form-data" className="mt-3 space-y-2">
          <input type="file" name="file" accept=".xlsx,.xls" required aria-label="Archivo de proveedores" className="block w-full text-sm" />
          <button
            type="submit"
            disabled={suppliersPending}
            className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {suppliersPending ? "Importando..." : "Importar proveedores"}
          </button>
        </form>

        {suppliersState.status === "success" && (
          <p role="status" className="mt-3 rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">
            ✓ {suppliersState.message}
          </p>
        )}
        {suppliersState.status === "conflict" && (
          <div role="alert" className="mt-3 rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
            <p className="font-medium">{suppliersState.message}</p>
            <ul className="mt-1 list-disc pl-5">
              {suppliersState.conflicts?.map((c) => (
                <li key={c.normalizedName}>
                  {c.normalizedName} — filas {c.rows.join(", ")}
                </li>
              ))}
            </ul>
          </div>
        )}
        {suppliersState.status === "error" && (
          <p role="alert" className="mt-3 rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
            {suppliersState.message}
          </p>
        )}
      </SectionCard>

      <SectionCard title="Generar nómina mensual">
        <p className="text-sm text-slate-600">
          Sube el Excel de facturas que envía finanzas (columnas Nro. Docto. / Nombre Cliente / Valor Total ($)). Se
          cruza por nombre exacto contra el maestro de proveedores — un nombre sin coincidencia queda fuera de la
          exportación final y se reporta abajo para revisión manual.
        </p>
        <form action={batchFormAction} encType="multipart/form-data" className="mt-3 space-y-2">
          <input type="file" name="file" accept=".xlsx,.xls" required aria-label="Excel mensual de facturas" className="block w-full text-sm" />
          <button
            type="submit"
            disabled={batchPending}
            className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {batchPending ? "Generando..." : "Generar nómina"}
          </button>
        </form>

        {batchState.status === "success" && (
          <div role="status" className="mt-3 space-y-2 rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">
            <p>✓ {batchState.message}</p>
            {batchState.batchId && (batchState.matchedCount ?? 0) > 0 && (
              <a href={`/nomina-de-pago/export/${batchState.batchId}`} className="inline-block rounded-md border border-success-border bg-white px-2 py-1 text-xs font-medium text-success hover:bg-success-bg">
                Descargar Excel para el banco →
              </a>
            )}
            {(batchState.unmatchedNames?.length ?? 0) > 0 && (
              <div className="text-critical">
                <p className="font-medium">Sin coincidencia en el maestro de proveedores:</p>
                <ul className="mt-1 list-disc pl-5">
                  {batchState.unmatchedNames!.map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {batchState.status === "error" && (
          <p role="alert" className="mt-3 rounded-md border border-critical-border bg-critical-bg px-3 py-2 text-sm text-critical">
            {batchState.message}
          </p>
        )}
      </SectionCard>

      <div className="lg:col-span-2">
        <SectionCard title="Nóminas generadas recientemente">
          {recentBatches.length === 0 ? (
            <p className="text-sm text-slate-500">Aún no se ha generado ninguna nómina.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="py-2 pr-4">Archivo</th>
                    <th scope="col" className="py-2 pr-4">Fecha</th>
                    <th scope="col" className="py-2 pr-4">Con datos</th>
                    <th scope="col" className="py-2 pr-4">Sin coincidencia</th>
                    <th scope="col" className="py-2 pr-4">Monto total</th>
                    <th scope="col" className="py-2 pr-4">Excel</th>
                  </tr>
                </thead>
                <tbody>
                  {recentBatches.map((batch) => (
                    <tr key={batch.id} className="border-b border-border last:border-0">
                      <td className="py-2 pr-4 text-slate-700">{batch.source_filename}</td>
                      <td className="py-2 pr-4 text-slate-500">{new Date(batch.generated_at).toLocaleString("es-CL")}</td>
                      <td className="py-2 pr-4">
                        <Badge label={String(batch.matched_count)} tone="positive" />
                      </td>
                      <td className="py-2 pr-4">
                        {batch.unmatched_count > 0 ? <Badge label={String(batch.unmatched_count)} tone="negative" /> : <Badge label="0" tone="neutral" />}
                      </td>
                      <td className="py-2 pr-4 text-slate-700">{formatCLP(batch.total_amount)}</td>
                      <td className="py-2 pr-4">
                        <a href={`/nomina-de-pago/export/${batch.id}`} className="text-arcotex-blue hover:underline">
                          Descargar
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
