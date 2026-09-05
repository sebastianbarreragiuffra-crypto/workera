import { redirect } from "next/navigation";
import { PlatformShell } from "@/components/platform";
import { getCurrentProfile } from "@/lib/auth/session";
import { getPlatformSession } from "@/lib/platform/authorization";
import { createClient } from "@/lib/supabase/server";
import { ARCOTEX_WORKFORCE_COMPANY_ID } from "@/lib/tenant/legacy-workforce";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const [session, profile] = await Promise.all([getPlatformSession(), getCurrentProfile()]);

  if (!profile) {
    redirect("/login");
  }
  if (!session) {
    redirect("/");
  }

  const supabase = await createClient();
  const workforceMembership = profile.role
    ? await supabase
        .from("company_memberships")
        .select("company_id, companies!inner(id)")
        .eq("company_id", ARCOTEX_WORKFORCE_COMPANY_ID)
        .eq("user_id", profile.id)
        .eq("active", true)
        .eq("companies.active", true)
        .eq("companies.status", "ACTIVE")
        .eq("companies.workspace_enabled", true)
        .maybeSingle()
    : { data: null, error: null };

  return (
    <PlatformShell
      displayName={profile.display_name}
      role={session.role}
      workspaceHref={!workforceMembership.error && workforceMembership.data ? "/dashboard" : null}
    >
      {children}
    </PlatformShell>
  );
}
