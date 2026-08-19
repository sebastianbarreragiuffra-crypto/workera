import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { ComingSoon } from "../../../components/shell/ComingSoon";

export default async function ConfigurationPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (profile.role !== "SUPER_ADMIN") redirect("/dashboard");

  return <ComingSoon title="Configuración" />;
}
