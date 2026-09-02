"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { deliverCompanyInvitation, type InvitationDeliveryResult } from "@/lib/admin/company-invitations";
import { PlatformAuthorizationError, requirePlatformManager } from "@/lib/platform/authorization";
import { createClient } from "@/lib/supabase/server";

export interface PlatformActionState {
  status: "idle" | "success" | "warning" | "error";
  message: string;
}

const uuid = z.string().uuid();
const optionalText = (max: number) => z.string().trim().max(max).transform((value) => value || null);
const managementRoleInput = z.object({
  companyId: uuid,
  membershipId: uuid,
  roleId: uuid,
});
const moduleStatusInput = z.object({
  companyId: uuid,
  moduleKey: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  status: z.enum(["ENABLED", "DISABLED", "PILOT", "SETUP_REQUIRED"]),
});
const onboardingInput = z.object({
  companyId: uuid,
  stepKey: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
  status: z.enum(["NOT_STARTED", "COMPLETE"]),
});
const invitationInput = z.object({
  companyId: uuid,
  email: z.string().trim().toLowerCase().email().max(254),
  roleId: uuid,
});
const resendInvitationInput = z.object({ companyId: uuid, invitationId: uuid });
const organizationInput = z.object({
  companyId: uuid,
  parentId: uuid,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]*$/).max(40),
  name: z.string().trim().min(2).max(120),
  unitType: z.enum(["DIVISION", "AREA", "DEPARTMENT", "TEAM", "OTHER"]),
});
const companyInput = z.object({
  name: z.string().trim().min(2).max(100),
  legalName: optionalText(160),
  slug: z.string().trim().max(63),
  planCode: z.enum(["CUSTOM", "STARTER", "GROWTH", "ENTERPRISE"]),
  primaryContactName: optionalText(120),
  primaryContactEmail: z.string().trim().toLowerCase().max(254).refine((value) => value === "" || z.string().email().safeParse(value).success).transform((value) => value || null),
  countryCode: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  timezone: z.string().trim().min(1).max(80).refine((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }),
});

type SupabaseMutationError = { code?: string; message?: string } | null;

function fields(formData: FormData): Record<string, FormDataEntryValue> {
  return Object.fromEntries(formData.entries());
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function failedValidation(): PlatformActionState {
  return { status: "error", message: "Revisa los campos e intenta nuevamente." };
}

function failedInvitationValidation(error: z.ZodError): PlatformActionState {
  const field = error.issues[0]?.path[0];
  if (field === "email") return { status: "error", message: "Ingresa un correo válido." };
  if (field === "roleId") return { status: "error", message: "Selecciona el rol que tendrá la persona." };
  return { status: "error", message: "No pudimos identificar la empresa. Recarga la página e inténtalo otra vez." };
}

async function invitationRedirectUrl(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return `${configured.replace(/\/$/, "")}/auth/confirm?next=%2F`;
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  if (origin) return `${origin.replace(/\/$/, "")}/auth/confirm?next=%2F`;
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  if (!host) throw new Error("No se pudo resolver el origen público de la aplicación.");
  return `${protocol}://${host}/auth/confirm?next=%2F`;
}

function deliveryState(result: InvitationDeliveryResult): PlatformActionState {
  if (result.status === "SENT") {
    return { status: "success", message: "Invitación registrada y correo enviado." };
  }
  if (result.status === "ACCOUNT_EXISTS") {
    return { status: "success", message: "Invitación registrada. La persona ya tiene una cuenta y puede ingresar con Google o con sus credenciales." };
  }
  return {
    status: "warning",
    message: "La invitación quedó registrada, pero el correo no pudo enviarse. Puedes reintentar desde la lista; en producción debes configurar el servicio SMTP.",
  };
}

async function deliverAndRecord(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invitationId: string,
  email: string
): Promise<PlatformActionState> {
  const result = await deliverCompanyInvitation(email, await invitationRedirectUrl());
  const { error } = await supabase.rpc("platform_mark_company_invitation_delivery", {
    p_invitation_id: invitationId,
    p_delivery_status: result.status,
    ...(result.status === "FAILED" ? { p_error_code: result.errorCode } : {}),
  });
  if (error) console.error("[platform] invitation delivery status failed", error.code ?? "unknown");
  return deliveryState(result);
}

function failure(operation: string, error: unknown): PlatformActionState {
  if (error instanceof PlatformAuthorizationError) {
    return { status: "error", message: "Tu rol no permite realizar esta acción." };
  }
  const mutationError = error as SupabaseMutationError;
  if (mutationError?.code === "23505") {
    return { status: "error", message: "Ya existe un registro con esos datos." };
  }
  console.error(`[platform] ${operation} failed`, error instanceof Error ? error.message : mutationError?.code ?? "unknown");
  return { status: "error", message: "No pudimos guardar el cambio. Intenta nuevamente." };
}

function revalidatePlatformCompanyPages(): void {
  revalidatePath("/plataforma");
  revalidatePath("/plataforma/empresas");
  revalidatePath("/plataforma/empresas/[companySlug]", "page");
}

export async function createCompanyAction(
  _previousState: PlatformActionState,
  formData: FormData
): Promise<PlatformActionState> {
  const parsed = companyInput.safeParse(fields(formData));
  if (!parsed.success) return failedValidation();

  const slug = slugify(parsed.data.slug || parsed.data.name);
  if (!slug) return { status: "error", message: "El identificador URL no es válido." };

  try {
    await requirePlatformManager();
    const supabase = await createClient();
    const { error } = await supabase.rpc("platform_create_company", {
      p_name: parsed.data.name,
      p_slug: slug,
      p_plan_code: parsed.data.planCode,
      p_country_code: parsed.data.countryCode,
      p_timezone: parsed.data.timezone,
      ...(parsed.data.legalName ? { p_legal_name: parsed.data.legalName } : {}),
      ...(parsed.data.primaryContactName ? { p_primary_contact_name: parsed.data.primaryContactName } : {}),
      ...(parsed.data.primaryContactEmail ? { p_primary_contact_email: parsed.data.primaryContactEmail } : {}),
    });
    if (error) throw error;
    revalidatePlatformCompanyPages();
    return { status: "success", message: "Empresa creada en modo onboarding. El workspace permanece bloqueado." };
  } catch (error) {
    return failure("create company", error);
  }
}

export async function inviteCompanyMemberAction(
  _previousState: PlatformActionState,
  formData: FormData
): Promise<PlatformActionState> {
  const parsed = invitationInput.safeParse(fields(formData));
  if (!parsed.success) return failedInvitationValidation(parsed.error);
  try {
    await requirePlatformManager();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("platform_create_company_invitation", {
      p_company_id: parsed.data.companyId,
      p_email: parsed.data.email,
      p_role_id: parsed.data.roleId,
    });
    let invitationId = data;
    if (error?.code === "23505") {
      const existing = await supabase
        .from("company_invitations")
        .select("id")
        .eq("company_id", parsed.data.companyId)
        .eq("email", parsed.data.email)
        .eq("status", "PENDING")
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      if (existing.error) throw existing.error;
      invitationId = existing.data?.id ?? null;
    } else if (error) {
      throw error;
    }
    if (!invitationId) throw new Error("No se obtuvo el identificador de la invitación.");
    const result = await deliverAndRecord(supabase, invitationId, parsed.data.email);
    revalidatePlatformCompanyPages();
    return result;
  } catch (error) {
    return failure("create invitation", error);
  }
}

export async function resendCompanyInvitationAction(
  _previousState: PlatformActionState,
  formData: FormData
): Promise<PlatformActionState> {
  const parsed = resendInvitationInput.safeParse(fields(formData));
  if (!parsed.success) return failedValidation();
  try {
    await requirePlatformManager();
    const supabase = await createClient();
    const { data: invitation, error } = await supabase
      .from("company_invitations")
      .select("id, email")
      .eq("id", parsed.data.invitationId)
      .eq("company_id", parsed.data.companyId)
      .eq("status", "PENDING")
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();
    if (error) throw error;
    if (!invitation) return { status: "error", message: "La invitación ya no está pendiente o venció." };
    const result = await deliverAndRecord(supabase, invitation.id, invitation.email);
    revalidatePlatformCompanyPages();
    return result;
  } catch (error) {
    return failure("resend invitation", error);
  }
}

export async function assignCompanyRoleAction(
  _previousState: PlatformActionState,
  formData: FormData
): Promise<PlatformActionState> {
  const parsed = managementRoleInput.safeParse(fields(formData));
  if (!parsed.success) return failedValidation();
  try {
    await requirePlatformManager();
    const supabase = await createClient();
    const { error } = await supabase.rpc("platform_assign_company_role", {
      p_membership_id: parsed.data.membershipId,
      p_role_id: parsed.data.roleId,
    });
    if (error) throw error;
    revalidatePlatformCompanyPages();
    return { status: "success", message: "Rol actualizado." };
  } catch (error) {
    return failure("assign company role", error);
  }
}

export async function setCompanyModuleStatusAction(
  _previousState: PlatformActionState,
  formData: FormData
): Promise<PlatformActionState> {
  const parsed = moduleStatusInput.safeParse(fields(formData));
  if (!parsed.success) return failedValidation();
  try {
    await requirePlatformManager();
    const supabase = await createClient();
    const { error } = await supabase.rpc("platform_set_company_module_status", {
      p_company_id: parsed.data.companyId,
      p_module_key: parsed.data.moduleKey,
      p_status: parsed.data.status,
    });
    if (error) throw error;
    revalidatePlatformCompanyPages();
    if (parsed.data.moduleKey === "expenses" && parsed.data.status === "PILOT") {
      return { status: "success", message: "Rendiciones quedó agregado a esta empresa en modo piloto." };
    }
    return { status: "success", message: "Estado del módulo actualizado." };
  } catch (error) {
    return failure("set module status", error);
  }
}

export async function setOnboardingStepStatusAction(
  _previousState: PlatformActionState,
  formData: FormData
): Promise<PlatformActionState> {
  const parsed = onboardingInput.safeParse(fields(formData));
  if (!parsed.success) return failedValidation();
  try {
    await requirePlatformManager();
    const supabase = await createClient();
    const { error } = await supabase.rpc("platform_set_onboarding_step_completed", {
      p_company_id: parsed.data.companyId,
      p_step_key: parsed.data.stepKey,
      p_completed: parsed.data.status === "COMPLETE",
    });
    if (error) throw error;
    revalidatePlatformCompanyPages();
    return { status: "success", message: parsed.data.status === "COMPLETE" ? "Paso completado." : "Paso reabierto." };
  } catch (error) {
    return failure("set onboarding step", error);
  }
}

export async function createOrganizationUnitAction(
  _previousState: PlatformActionState,
  formData: FormData
): Promise<PlatformActionState> {
  const parsed = organizationInput.safeParse(fields(formData));
  if (!parsed.success) return failedValidation();
  try {
    await requirePlatformManager();
    const supabase = await createClient();
    const { error } = await supabase.rpc("platform_create_organization_unit", {
      p_company_id: parsed.data.companyId,
      p_parent_id: parsed.data.parentId,
      p_code: parsed.data.code,
      p_name: parsed.data.name,
      p_unit_type: parsed.data.unitType,
      p_sort_order: 0,
    });
    if (error) throw error;
    revalidatePlatformCompanyPages();
    return { status: "success", message: "Unidad agregada al organigrama." };
  } catch (error) {
    return failure("create organization unit", error);
  }
}
