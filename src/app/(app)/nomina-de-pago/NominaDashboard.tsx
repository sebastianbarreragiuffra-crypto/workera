"use client";

import { useActionState } from "react";
import { SectionCard } from "../../../components/shell/SectionCard";
import { Badge } from "../../../components/shell/Badge";
import { generatePayrollBatchAction, uploadSuppliersAction, type GenerateBatchActionState, type UploadSuppliersActionState } from "./actions";
import { FileUploadBox } from "./FileUploadBox";

interface RecentBatch {
  id: string;
  source_filename: string;
  generated_at: string;
  matched_count: number;
  unmatched_count: number;
  total_amount: number;
}

const GENERATE_BATCH_INITIAL: GenerateBatchActionState = { status: "idle", message: "" };
const UPLOAD_SUPPLIERS_INITIAL: UploadSuppliersActionState = { status: "idle", message: "" };

function formatCLP(amount: number): string {
  return amount.toLocaleString("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
}

export function NominaDashboard({ recentBatches }: { recentBatches: RecentBatch[] }) {
  const [batchState, batchFormAction, batchPending] = useActionState(generatePayrollBatchAction, GENERATE_BATCH_INITIAL);
  const [suppliersState, suppliersFormAction, suppliersPending] = useActionState(uploadSuppliersAction, UPLOAD_SUPPLIERS_INITIAL);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title="Nómina mensual">
        <p className="text-sm text-slate-600">
          Sube el Excel de facturas que envía finanzas. Se genera la nómina automáticamente, cruzando cada proveedor
          con sus datos bancarios -- descarga el Excel generado abajo para confirmar que todo quedó correcto.
        </p>
        <form action={batchFormAction} className="mt-3">
          <FileUploadBox
            name="file"
            accept=".xlsx,.xls"
            ariaLabel="Excel mensual de facturas"
            pending={batchPending}
            pendingLabel="Generando..."
          />
        </form>

        {batchState.status === "success" && (
          <div role="status" className="mt-3 space-y-2 rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm text-success">
            <p>✓ Nómina generada -- {((batchState.matchedCount ?? 0) + (batchState.unmatchedCount ?? 0))} facturas procesadas.</p>
            <p>Monto total: {formatCLP(batchState.totalAmount ?? 0)}</p>
            <p>Proveedores encontrados: {batchState.matchedCount ?? 0}</p>
            <p className={(batchState.unmatchedCount ?? 0) > 0 ? "text-critical font-medium" : ""}>
              Proveedores no encontrados: {batchState.unmatchedCount ?? 0}
            </p>
            {batchState.batchId && (
              <a href={`/nomina-de-pago/export/${batchState.batchId}`} className="inline-block rounded-md border border-success-border bg-white px-2 py-1 text-xs font-medium text-success hover:bg-success-bg">
                Descargar Excel para confirmar →
              </a>
            )}
            {(batchState.unmatchedNames?.length ?? 0) > 0 && (
              <div className="text-critical">
                <p className="font-medium">🔴 {batchState.unmatchedNames!.length} registros requieren revisión -- sin coincidencia en el maestro de proveedores:</p>
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

      <SectionCard title="Listado de proveedores">
        <p className="text-sm text-slate-600">
          Sube el listado de proveedores (Rut, Nombre Beneficiario, FP, BCO, N° Cuenta Cte.) para agregar nuevos
          proveedores o actualizar sus datos bancarios. Un proveedor con el mismo nombre se actualiza; nunca se
          duplica.
        </p>
        <form action={suppliersFormAction} className="mt-3">
          <FileUploadBox
            name="file"
            accept=".xlsx,.xls"
            ariaLabel="Archivo de proveedores"
            pending={suppliersPending}
            pendingLabel="Importando..."
          />
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
