import { redirect } from "next/navigation";
import { PlatformShell } from "@/components/platform";
import { getCurrentProfile } from "@/lib/auth/session";
import { getPlatformSession } from "@/lib/platform/authorization";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const [session, profile] = await Promise.all([getPlatformSession(), getCurrentProfile()]);

  if (!profile) {
    redirect("/login");
  }
  if (!session) {
    redirect(profile.role ? "/dashboard" : "/login");
  }

  return (
    <PlatformShell
      displayName={profile.display_name}
      role={session.role}
      workspaceHref={profile.role ? "/dashboard" : null}
    >
      {children}
    </PlatformShell>
  );
}
