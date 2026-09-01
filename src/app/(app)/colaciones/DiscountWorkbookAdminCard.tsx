"use client";

import { useActionState } from "react";
import { SectionCard } from "../../../components/shell/SectionCard";
import { Badge } from "../../../components/shell/Badge";
import { updateDiscountWorkbookAction, type UpdateDiscountWorkbookActionState } from "./discount-workbook-actions";
import type { DiscountWorkbookMeta } from "../../../lib/colaciones/discount-workbook-storage";
import { formatDateTimeInSantiago } from "../../../lib/view-models/date-utils";

const INITIAL_STATE: UpdateDiscountWorkbookActionState = { status: "idle", message: "" };

function formatUploadedAt(iso: string) {
  return formatDateTimeInSantiago(iso);
}

/**
 * Control compacto, solo-admin, para reemplazar el Excel de descuentos
 * activo -- separado del flujo normal de subir el menú/responder el
 * formulario (nunca lo interrumpe). La página completa de Colaciones ya
 * está gateada a SUPER_ADMIN/ADMIN_RRHH (`isPrivilegedAdmin` en page.tsx),
 * así que todo quien ve esta tarjeta ya es admin -- el Server Action
 * igual vuelve a verificarlo server-side, nunca confía solo en que el
 * botón esté visible.
 */
export function DiscountWorkbookAdminCard({ activeWorkbook }: { activeWorkbook: DiscountWorkbookMeta | null }) {
  const [state, formAction, pending] = useActionState(updateDiscountWorkbookAction, INITIAL_STATE);

  return (
    <SectionCard title="Actualizar archivo de descuentos" actions={<Badge label="Solo administración" tone="info" />}>
      <div className="space-y-1 text-xs text-slate-600">
        <p>
          Archivo activo: <span className="font-medium text-slate-800">{activeWorkbook?.originalFilename ?? "ninguno configurado"}</span>
        </p>
        <p>
          Última actualización: <span className="font-medium text-slate-800">{activeWorkbook ? formatUploadedAt(activeWorkbook.uploadedAt) : "—"}</span>
        </p>
      </div>

      <form action={formAction} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="file"
          name="file"
          accept=".xlsx,.xls"
          aria-label="Nuevo archivo de descuentos"
          className="min-w-0 flex-1 text-xs"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-md border border-arcotex-blue px-3 py-1.5 text-xs font-medium text-arcotex-blue hover:bg-arcotex-blue/5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Actualizando..." : "Actualizar"}
        </button>
      </form>

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
