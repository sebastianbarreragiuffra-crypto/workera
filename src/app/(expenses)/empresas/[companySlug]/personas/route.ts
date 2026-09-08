import { NextResponse, type NextRequest } from "next/server";
import { getCurrentProfile } from "@/lib/auth/session";
import { publicAppUrl } from "@/lib/auth/public-origin";
import { createClient } from "@/lib/supabase/server";
import {
  ACTIVE_WORKFORCE_COMPANY_COOKIE,
  isOperationalWorkforceMembership,
} from "@/lib/tenant/active-workforce-company";
import { resolveActiveCompany } from "@/lib/tenant/resolve-active-company";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ companySlug: string }> },
) {
  const profile = await getCurrentProfile();
  if (!profile) {
    return NextResponse.redirect(publicAppUrl("/login", request.nextUrl.origin));
  }

  const { companySlug } = await params;
  const supabase = await createClient();
  const resolution = await resolveActiveCompany(supabase);
  const memberships = resolution.kind === "NONE"
    ? []
    : resolution.kind === "SINGLE"
      ? [resolution.membership]
      : resolution.memberships;
  const membership = memberships.find((item) =>
    item.companySlug === companySlug.toLowerCase() && isOperationalWorkforceMembership(item)
  );
  if (!membership) {
    return NextResponse.json({ error: "El workspace laboral no está disponible para esta empresa." }, { status: 404 });
  }

  const response = NextResponse.redirect(publicAppUrl("/dashboard", request.nextUrl.origin));
  response.cookies.set(ACTIVE_WORKFORCE_COMPANY_COOKIE, membership.companyId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
