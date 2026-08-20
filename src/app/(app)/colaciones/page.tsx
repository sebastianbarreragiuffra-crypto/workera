import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { createClient } from "../../../lib/supabase/server";
import { getProductionMealDiscountDataset } from "../../../lib/colaciones/source-workbook";
import { getWeeklyMealGoogleFormStatus, listWeeklyMealGoogleForms, type CreatedWeeklyMealGoogleForm, type WeeklyMealGoogleFormStatus } from "../../../lib/colaciones/google-forms";
import { buildMealResponseTracking, type MealEligibleWorker, type MealResponseTracking } from "../../../lib/colaciones/response-tracking";
import { getMealFormBusinessState } from "../../../lib/colaciones/form-business-state";
import type { ProductionMealDiscountDataset } from "../../../lib/colaciones/types";
import { ColacionesDashboard } from "./ColacionesDashboard";

export default async function ColacionesPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") redirect("/dashboard");

  let discountDataset: ProductionMealDiscountDataset | null = null;
  let discountError: string | null = null;
  let recentForms: CreatedWeeklyMealGoogleForm[] = [];
  let formsError: string | null = null;
  let activeForm: CreatedWeeklyMealGoogleForm | null = null;
  let activeFormStatus: WeeklyMealGoogleFormStatus | null = null;
  let responseTracking: MealResponseTracking | null = null;
  let trackingError: string | null = null;
  try {
    discountDataset = await getProductionMealDiscountDataset();
  } catch (error) {
    console.error("[colaciones] No se pudo cargar el Excel de descuentos de Producción", error);
    discountError = error instanceof Error ? error.message : "No se pudo leer el Excel de descuentos.";
  }

  try {
    recentForms = await listWeeklyMealGoogleForms();
    activeForm = recentForms[0] ?? null;
  } catch (error) {
    console.error("[colaciones] No se pudo cargar el historial de formularios", error);
    formsError = error instanceof Error ? error.message : "No se pudo cargar el historial de formularios.";
  }

  if (activeForm) {
    try {
      const supabase = await createClient();
      const [{ data: employees, error: employeesError }, status] = await Promise.all([
        supabase.from("employees").select("id, first_name, last_name, display_name").eq("active", true).order("display_name"),
        getWeeklyMealGoogleFormStatus(activeForm.formId),
      ]);
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
      recentForms={recentForms}
      formsError={formsError}
      activeForm={activeForm}
      formBusinessState={formBusinessState}
      responseTracking={responseTracking}
      trackingError={trackingError}
    />
  );
}
