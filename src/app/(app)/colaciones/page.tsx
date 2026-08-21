import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { createClient } from "../../../lib/supabase/server";
import { isPrivilegedAdmin } from "../../../lib/supabase/authorize";
import { getActiveDiscountWorkbookDataset, getActiveDiscountWorkbookMeta, type DiscountWorkbookMeta } from "../../../lib/colaciones/discount-workbook-storage";
import { getWeeklyMealGoogleFormStatus, listWeeklyMealGoogleForms, type CreatedWeeklyMealGoogleForm, type WeeklyMealGoogleFormStatus } from "../../../lib/colaciones/google-forms";
import { buildMealResponseTracking, type MealEligibleWorker, type MealResponseTracking } from "../../../lib/colaciones/response-tracking";
import { getMealFormBusinessState } from "../../../lib/colaciones/form-business-state";
import type { ProductionMealDiscountDataset } from "../../../lib/colaciones/types";
import { ColacionesDashboard } from "./ColacionesDashboard";

/**
 * `page.tsx` solo resuelve la auth (rápida, local) antes de la primera
 * respuesta. TODO lo demás -- el Excel de descuentos (ahora Supabase
 * Storage, ya no filesystem local -- ver `discount-workbook-storage.ts`) Y
 * Google Forms (llamadas externas al Apps Script, con su propio timeout de
 * 20s cada una en `google-forms.ts`) -- queda detrás de un `<Suspense>`:
 * así el layout/nav/shell de la página SIEMPRE llega de inmediato al hacer
 * clic en "Colaciones" en el menú, sin importar cuánto tarde Storage o
 * Google -- el mismo motivo por el que Google Forms ya estaba detrás de
 * Suspense (ver commit de performance anterior); el Excel se movió acá
 * también porque dejó de ser una lectura de disco instantánea y pasó a ser
 * una descarga real desde Storage.
 */
export default async function ColacionesPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (!isPrivilegedAdmin(profile.role)) redirect("/dashboard");

  return (
    <Suspense fallback={<ColacionesLoadingFallback />}>
      <ColacionesGoogleFormsSection />
    </Suspense>
  );
}

function ColacionesLoadingFallback() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">Colaciones</h1>
        <p className="mt-1 text-sm text-slate-500">Planifica el menú, comparte el formulario y prepara los cobros semanales.</p>
      </div>
      <div role="status" className="flex items-center gap-3 rounded-lg border border-border bg-card p-6 text-sm text-slate-600 shadow-sm">
        <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-arcotex-blue border-t-transparent" />
        Cargando información de Colaciones...
      </div>
    </div>
  );
}

/**
 * Sección async con TODO lo que depende de una fuente externa (Storage o
 * Google) -- aislada en su propio componente para envolverla en
 * `<Suspense>` sin tocar el contrato de props de `ColacionesDashboard`. La
 * consulta a `employees`, el listado de Google Forms, y la lectura del
 * Excel activo se disparan en paralelo -- son independientes entre sí, solo
 * `getWeeklyMealGoogleFormStatus` depende del resultado del listado
 * (necesita `activeForm.formId`).
 *
 * `discountWorkbookMeta` se consulta por separado de `discountDataset`
 * (una query extra, de una sola fila, costo despreciable) para que la
 * tarjeta de administración siga mostrando qué archivo está activo incluso
 * si la descarga/parseo del Excel falla -- así el admin sabe qué reemplazar.
 */
async function ColacionesGoogleFormsSection() {
  let recentForms: CreatedWeeklyMealGoogleForm[] = [];
  let formsError: string | null = null;
  let activeForm: CreatedWeeklyMealGoogleForm | null = null;
  let activeFormStatus: WeeklyMealGoogleFormStatus | null = null;
  let responseTracking: MealResponseTracking | null = null;
  let trackingError: string | null = null;
  let discountDataset: ProductionMealDiscountDataset | null = null;
  let discountError: string | null = null;
  let discountWorkbookMeta: DiscountWorkbookMeta | null = null;

  const supabase = await createClient();
  const employeesPromise = supabase.from("employees").select("id, first_name, last_name, display_name").eq("active", true).order("display_name");
  const discountDatasetPromise = getActiveDiscountWorkbookDataset(supabase);

  try {
    recentForms = await listWeeklyMealGoogleForms();
    activeForm = recentForms[0] ?? null;
  } catch (error) {
    console.error("[colaciones] No se pudo cargar el historial de formularios", error);
    formsError = error instanceof Error ? error.message : "No se pudo cargar el historial de formularios.";
  }

  try {
    const result = await discountDatasetPromise;
    if (!result) {
      discountError = "Falta configurar el archivo de descuentos de Colaciones.";
    } else {
      discountDataset = result.dataset;
      discountWorkbookMeta = result.meta;
    }
  } catch (error) {
    console.error("[colaciones] No se pudo cargar el Excel de descuentos de Producción", error);
    discountError = error instanceof Error ? error.message : "No se pudo leer el Excel de descuentos.";
  }

  if (!discountWorkbookMeta) {
    // discountDatasetPromise falló o no había archivo activo -- igual intentamos traer solo la
    // metadata (consulta liviana, sin descargar/parsear) para que la tarjeta de admin muestre
    // qué archivo sigue activo aunque la descarga/parseo del Excel haya fallado.
    try {
      discountWorkbookMeta = await getActiveDiscountWorkbookMeta(supabase);
    } catch {
      discountWorkbookMeta = null;
    }
  }

  if (activeForm) {
    try {
      const [{ data: employees, error: employeesError }, status] = await Promise.all([employeesPromise, getWeeklyMealGoogleFormStatus(activeForm.formId)]);
      if (employeesError) throw new Error(`No se pudo cargar la nómina activa: ${employeesError.message}`);
      const workers: MealEligibleWorker[] = (employees ?? []).map((employee) => ({
        employeeId: employee.id,
        firstName: employee.first_name,
        lastName: employee.last_name,
        displayName: employee.display_name,
      }));
      activeFormStatus = status;
      responseTracking = buildMealResponseTracking(workers, status.respondentNames);
    } catch (error) {
      console.error("[colaciones] No se pudo calcular el seguimiento del formulario activo", error);
      trackingError = error instanceof Error ? error.message : "No se pudo calcular quiénes están pendientes.";
    }
  }

  const formBusinessState = getMealFormBusinessState(activeForm, activeFormStatus);

  return (
    <ColacionesDashboard
      discountDataset={discountDataset}
      discountError={discountError}
      discountWorkbookMeta={discountWorkbookMeta}
      recentForms={recentForms}
      formsError={formsError}
      activeForm={activeForm}
      formBusinessState={formBusinessState}
      responseTracking={responseTracking}
      trackingError={trackingError}
    />
  );
}
