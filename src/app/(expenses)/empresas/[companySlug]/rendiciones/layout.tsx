import { notFound, redirect } from "next/navigation";
import { ExpenseShell } from "@/components/expenses/ExpenseShell";
import { getCurrentProfile } from "@/lib/auth/session";
import { getExpenseCompanyContextFromClient, listExpenseCompaniesFromClient } from "@/lib/expenses/access";
import { createClient } from "@/lib/supabase/server";

export default async function ExpenseCompanyLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ companySlug: string }>;
}) {
  const [profile, { companySlug }] = await Promise.all([getCurrentProfile(), params]);
  if (!profile) redirect(`/login?next=${encodeURIComponent(`/empresas/${companySlug}/rendiciones`)}`);

  const supabase = await createClient();
  const [context, companies] = await Promise.all([
    getExpenseCompanyContextFromClient(supabase, companySlug),
    listExpenseCompaniesFromClient(supabase, profile.id),
  ]);
  if (!context) notFound();

  return <ExpenseShell context={context} companies={companies}>{children}</ExpenseShell>;
}
