"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "../../../lib/auth/session";
import { createClient } from "../../../lib/supabase/server";
import { isPrivilegedAdmin } from "../../../lib/supabase/authorize";
import { updateActiveDiscountWorkbook } from "../../../lib/colaciones/discount-workbook-storage";
import { enforceWorkforceActionRateLimit } from "../../../lib/decisions/workforce-action-rate-limit";

/**
 * Reemplazo del Excel de descuentos de Colaciones. Privilegiado (mismo
 * criterio ya centralizado en `isPrivilegedAdmin` -- coincide exactamente
 * con quién puede ver el panel de Colaciones que lo consume, no se amplía
 * ni se reduce nada). Server-side obligatorio -- nunca confía en que el
 * botón esté oculto en el cliente.
 */

const MAX_DISCOUNT_WORKBOOK_SIZE_BYTES = 5 * 1024 * 1024;

export interface UpdateDiscountWorkbookActionState {
  status: "idle" | "success" | "error";
  message: string;
}

export async function updateDiscountWorkbookAction(
  _prev: UpdateDiscountWorkbookActionState,
  formData: FormData
): Promise<UpdateDiscountWorkbookActionState> {
  const profile = await getCurrentProfile();
  if (!profile?.role || !isPrivilegedAdmin(profile.role)) {
    return { status: "error", message: "No tienes permiso para actualizar el archivo de descuentos." };
  }
  try {
    await enforceWorkforceActionRateLimit(await createClient(), "workforce.meals.manage");
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Acción bloqueada por seguridad." };
  }

  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) {
    return { status: "error", message: "Selecciona el archivo de descuentos antes de continuar." };
  }
  if (!/\.(xlsx|xls)$/i.test(file.name)) {
    return { status: "error", message: "El archivo debe ser un Excel (.xlsx o .xls)." };
  }
  if (file.size > MAX_DISCOUNT_WORKBOOK_SIZE_BYTES) {
    return { status: "error", message: `El archivo supera el máximo permitido (${Math.round(MAX_DISCOUNT_WORKBOOK_SIZE_BYTES / 1024 / 1024)} MB).` };
  }

  const supabase = await createClient();
  const fileBytes = new Uint8Array(await file.arrayBuffer());

  try {
    await updateActiveDiscountWorkbook(supabase, {
      fileBytes,
      originalFilename: file.name,
      uploadedBy: profile.id,
    });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "No pudimos actualizar el archivo de descuentos." };
  }

  revalidatePath("/colaciones");
  return { status: "success", message: "Archivo de descuentos actualizado -- el archivo anterior queda en el historial, nunca se pierde." };
}
