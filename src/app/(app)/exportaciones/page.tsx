import { redirect } from "next/navigation";
import { getCurrentProfile } from "../../../lib/auth/session";
import { isPrivilegedAdmin } from "../../../lib/supabase/authorize";
import { ComingSoon } from "../../../components/shell/ComingSoon";

export default async function ExportsPage() {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");
  if (!isPrivilegedAdmin(profile.role)) redirect("/dashboard");

  return <ComingSoon title="Exportaciones" />;
}
