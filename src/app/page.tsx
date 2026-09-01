import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";

export default async function RootPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");

  const supabase = await createClient();
  const { data: platformMembership } = await supabase
    .from("platform_memberships")
    .select("role")
    .eq("user_id", profile.id)
    .eq("active", true)
    .maybeSingle();

  if (platformMembership) redirect("/plataforma");
  if (profile.role) redirect("/dashboard");
  redirect("/login");
}
