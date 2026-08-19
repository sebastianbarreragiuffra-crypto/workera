import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { ComingSoon } from "../../../components/shell/ComingSoon";

export default async function ReportingPeriodsPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN" && profile.role !== "ADMIN_RRHH") redirect("/dashboard");

  return <ComingSoon title="Períodos" />;
}
