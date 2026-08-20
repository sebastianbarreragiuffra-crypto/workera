import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { createClient } from "../../../lib/supabase/server";
import { PageHeader } from "../../../components/shell/PageHeader";
import { NominaDashboard } from "./NominaDashboard";

export default async function NominaDePagoPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") redirect("/dashboard");

  const supabase = await createClient();

  const [suppliersCountRes, batchesRes] = await Promise.all([
    supabase.from("suppliers").select("id", { count: "exact", head: true }).eq("active", true),
    supabase
      .from("payroll_batches")
      .select("id, source_filename, generated_at, matched_count, unmatched_count, total_amount")
      .order("generated_at", { ascending: false })
      .limit(10),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title="Nómina de Pago" subtitle="Maestro de proveedores y generación de nómina para el portal bancario" />
      <NominaDashboard suppliersCount={suppliersCountRes.count ?? 0} recentBatches={batchesRes.data ?? []} />
    </div>
  );
}
