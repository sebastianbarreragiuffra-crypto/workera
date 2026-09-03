import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpenseCompanyContext } from "./access";
import type { Database } from "@/lib/supabase/database.types";
import { isCalendarDate, nextDate, santiagoDayStartIso } from "@/lib/view-models/date-utils";
import { unwrapEmbed } from "@/lib/supabase/embed";

export type ExpenseReportStatus = Database["public"]["Enums"]["expense_report_status"];

export const EXPENSE_PAGE_SIZE = 25;

export const EXPENSE_REPORT_STATUSES: readonly ExpenseReportStatus[] = [
  "DRAFT", "SUBMITTED", "IN_REVIEW", "APPROVED", "REJECTED", "PAID", "CANCELLED",
];

/** Estados que realmente esperan una decisión -- el resto no pertenece a la bandeja. */
export const EXPENSE_PENDING_STATUSES: readonly ExpenseReportStatus[] = ["SUBMITTED", "IN_REVIEW"];

export interface ExpensePagination {
  page: number;
  pageSize: number;
  totalCount: number;
}

/**
 * Filtros del historial y de la bandeja. Se resuelven SIEMPRE en la base
 * (`range` + `count: exact`): traer el historial completo para recortarlo en
 * memoria deja de funcionar apenas la empresa acumula meses de rendiciones.
 */
export interface ExpenseListFilters {
  page?: number;
  status?: ExpenseReportStatus | null;
  from?: string | null;
  to?: string | null;
}

function resolvePage(page: number | undefined): number {
  return Math.max(1, Math.trunc(page ?? 1));
}

/**
 * El formato por sí solo no basta: "2026-13-45" lo cumple y no existe. Como
 * estas fechas terminan en `santiagoDayStartIso` --que valida el día real y
 * LANZA-- dejar pasar una imposible convertía `?desde=` en un 500.
 */
function parseCalendarDate(value: string | undefined): string | null {
  return value && isCalendarDate(value) ? value : null;
}

/**
 * Traduce la query string a filtros ya validados. Todo valor que no calce con
 * el enum o con `YYYY-MM-DD` se descarta en silencio: la URL la escribe
 * cualquiera, así que nunca puede llegar cruda a la consulta.
 */
export function parseExpenseListFilters(query: {
  pagina?: string;
  estado?: string;
  desde?: string;
  hasta?: string;
}): ExpenseListFilters {
  const page = Number.parseInt(query.pagina ?? "1", 10);
  const status = EXPENSE_REPORT_STATUSES.find((candidate) => candidate === query.estado) ?? null;
  const from = parseCalendarDate(query.desde);
  const to = parseCalendarDate(query.hasta);
  return {
    // `isFinite` acepta 0 y negativos: `?pagina=0` daba el rango [-20, -1],
    // que PostgREST rechaza y termina en un 500 provocable desde la URL.
    // Mismo criterio que ya usa /plataforma/empresas.
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    status,
    // Un rango invertido no devuelve nada y confunde; se ignora el extremo malo.
    from,
    to: from && to && to < from ? null : to,
  };
}

function rangeFor(page: number): [number, number] {
  return [(page - 1) * EXPENSE_PAGE_SIZE, page * EXPENSE_PAGE_SIZE - 1];
}

/** Ventana `[desde, hasta]` como intervalo semiabierto en hora de Santiago. */
function applyDateWindow<T extends { gte: (c: string, v: string) => T; lt: (c: string, v: string) => T }>(
  query: T,
  column: string,
  filters: ExpenseListFilters
): T {
  let next = query;
  if (filters.from) next = next.gte(column, santiagoDayStartIso(filters.from));
  if (filters.to) next = next.lt(column, santiagoDayStartIso(nextDate(filters.to)));
  return next;
}

export interface ExpenseReportSummary {
  id: string;
  referenceNumber: string;
  title: string;
  status: ExpenseReportStatus;
  currencyCode: string;
  totalAmount: number;
  createdAt: string;
  submittedAt: string | null;
  isOwn: boolean;
}

export interface ExpenseDashboardData {
  reports: ExpenseReportSummary[];
  pagination: ExpensePagination;
  draftCount: number;
  reviewCount: number;
  approvedCount: number;
  visibleTotal: number;
}

export interface ExpenseCategoryOption {
  id: string;
  name: string;
  requiresReceipt: boolean;
}

export interface ExpenseItemDetail {
  id: string;
  categoryId: string | null;
  expenseDate: string;
  merchantName: string | null;
  description: string;
  netAmount: number;
  taxAmount: number;
  totalAmount: number;
  distanceKm: number | null;
  receiptStatus: Database["public"]["Enums"]["expense_receipt_status"];
  receipt: {
    id: string;
    originalFilename: string;
    status: Database["public"]["Enums"]["expense_receipt_status"];
    duplicateOfReceiptId: string | null;
    createdAt: string;
    extraction: ExpenseReceiptExtraction | null;
  } | null;
}

export interface ExpenseReceiptExtraction {
  fields: {
    merchantName: { value: string | null; confidence: number | null };
    transactionDate: { value: string | null; confidence: number | null };
    subtotal: { value: number | null; confidence: number | null };
    totalTax: { value: number | null; confidence: number | null };
    total: { value: number | null; confidence: number | null };
    currencyCode: { value: string | null; confidence: number | null };
  };
  confidence: number | null;
  discrepancies: Array<{ field: string; declared: string | number | null; extracted: string | number | null }>;
  requiresHumanReview: boolean;
  humanReview?: { decision?: "ACCEPTED" | "REJECTED"; comment?: string | null };
}

function parseReceiptExtraction(value: unknown): ExpenseReceiptExtraction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ExpenseReceiptExtraction>;
  if (!candidate.fields || !Array.isArray(candidate.discrepancies) || typeof candidate.requiresHumanReview !== "boolean") return null;
  return candidate as ExpenseReceiptExtraction;
}

export interface ExpenseReportDetail extends ExpenseReportSummary {
  purpose: string | null;
  policyId: string | null;
  reviewRound: number;
  requiredApprovalSteps: number;
  paidAt: string | null;
  paidBy: string | null;
  paymentReference: string | null;
  advanceId: string | null;
  organizationUnitId: string | null;
  items: ExpenseItemDetail[];
  categories: ExpenseCategoryOption[];
  decisions: Array<{
    id: string;
    reviewRound: number;
    stepNumber: number;
    decision: Database["public"]["Enums"]["expense_approval_decision"];
    comment: string | null;
    decidedAt: string;
    decidedBy: string;
  }>;
}

export interface ExpenseApprovalQueueItem extends ExpenseReportSummary {
  submitterName: string;
}

export async function getExpenseDashboard(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  filters: ExpenseListFilters = {}
): Promise<ExpenseDashboardData> {
  const page = resolvePage(filters.page);
  const [start, end] = rangeFor(page);

  let reportsQuery = supabase
    .from("expense_reports")
    .select(
      "id, reference_number, title, status, currency_code, total_amount, created_at, submitted_at, submitted_by",
      { count: "exact" }
    )
    .eq("company_id", context.id);
  if (filters.status) reportsQuery = reportsQuery.eq("status", filters.status);
  reportsQuery = applyDateWindow(reportsQuery, "created_at", filters);

  const [reportsResult, summaryResult] = await Promise.all([
    reportsQuery.order("created_at", { ascending: false }).range(start, end),
    // Los KPI siguen resolviéndose en la base sobre TODO el historial visible:
    // son el total de la empresa, no el de la página que se está mirando.
    supabase.rpc("expense_dashboard_summary", { p_company_id: context.id }).single(),
  ]);
  if (reportsResult.error || summaryResult.error) throw new Error("No se pudieron cargar las rendiciones.");

  const reports = (reportsResult.data ?? []).map((report) => ({
    id: report.id,
    referenceNumber: report.reference_number,
    title: report.title,
    status: report.status,
    currencyCode: report.currency_code,
    totalAmount: Number(report.total_amount),
    createdAt: report.created_at,
    submittedAt: report.submitted_at,
    isOwn: report.submitted_by === context.userId,
  }));

  return {
    reports,
    pagination: { page, pageSize: EXPENSE_PAGE_SIZE, totalCount: reportsResult.count ?? reports.length },
    draftCount: Number(summaryResult.data.draft_count),
    reviewCount: Number(summaryResult.data.review_count),
    approvedCount: Number(summaryResult.data.approved_count),
    visibleTotal: Number(summaryResult.data.visible_total),
  };
}

export async function getExpenseReportDetail(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  reportId: string
): Promise<ExpenseReportDetail | null> {
  const [reportResult, itemsResult, categoriesResult, receiptsResult, decisionsResult] = await Promise.all([
    supabase
      .from("expense_reports")
      .select("id, reference_number, title, purpose, policy_id, status, currency_code, total_amount, created_at, submitted_at, submitted_by, review_round, required_approval_steps, paid_at, paid_by, payment_reference, advance_id, organization_unit_id")
      .eq("company_id", context.id)
      .eq("id", reportId)
      .maybeSingle(),
    supabase
      .from("expense_items")
      .select("id, category_id, expense_date, merchant_name, description, net_amount, tax_amount, total_amount, receipt_status, distance_km")
      .eq("company_id", context.id)
      .eq("report_id", reportId)
      .order("expense_date", { ascending: false }),
    supabase
      .from("expense_categories")
      .select("id, name, requires_receipt")
      .eq("company_id", context.id)
      .eq("active", true)
      .order("name"),
    supabase
      .from("expense_receipts")
      .select("id, item_id, original_filename, status, duplicate_of_receipt_id, created_at, extraction")
      .eq("company_id", context.id)
      .eq("report_id", reportId)
      .eq("is_current", true),
    supabase
      .from("expense_approval_decisions")
      .select("id, review_round, step_number, decision, comment, decided_at, decided_by")
      .eq("company_id", context.id)
      .eq("report_id", reportId)
      .order("review_round", { ascending: false })
      .order("step_number", { ascending: false }),
  ]);

  if (reportResult.error || itemsResult.error || categoriesResult.error || receiptsResult.error || decisionsResult.error) {
    throw new Error("No se pudo cargar el detalle de la rendición.");
  }
  if (!reportResult.data) return null;
  const report = reportResult.data;
  const receiptsByItem = new Map((receiptsResult.data ?? []).map((receipt) => [receipt.item_id, receipt]));

  return {
    id: report.id,
    referenceNumber: report.reference_number,
    title: report.title,
    purpose: report.purpose,
    policyId: report.policy_id,
    reviewRound: report.review_round,
    requiredApprovalSteps: report.required_approval_steps,
    paidAt: report.paid_at,
    paidBy: report.paid_by,
    paymentReference: report.payment_reference,
    advanceId: report.advance_id,
    organizationUnitId: report.organization_unit_id,
    status: report.status,
    currencyCode: report.currency_code,
    totalAmount: Number(report.total_amount),
    createdAt: report.created_at,
    submittedAt: report.submitted_at,
    isOwn: report.submitted_by === context.userId,
    items: (itemsResult.data ?? []).map((item) => {
      const receipt = receiptsByItem.get(item.id);
      return {
        id: item.id,
        categoryId: item.category_id,
        expenseDate: item.expense_date,
        merchantName: item.merchant_name,
        description: item.description,
        netAmount: Number(item.net_amount),
        taxAmount: Number(item.tax_amount),
        totalAmount: Number(item.total_amount ?? 0),
        distanceKm: item.distance_km === null ? null : Number(item.distance_km),
        receiptStatus: item.receipt_status,
        receipt: receipt ? {
          id: receipt.id,
          originalFilename: receipt.original_filename,
          status: receipt.status,
          duplicateOfReceiptId: receipt.duplicate_of_receipt_id,
          createdAt: receipt.created_at,
          extraction: parseReceiptExtraction(receipt.extraction),
        } : null,
      };
    }),
    categories: (categoriesResult.data ?? []).map((category) => ({
      id: category.id,
      name: category.name,
      requiresReceipt: category.requires_receipt,
    })),
    decisions: (decisionsResult.data ?? []).map((decision) => ({
      id: decision.id,
      reviewRound: decision.review_round,
      stepNumber: decision.step_number,
      decision: decision.decision,
      comment: decision.comment,
      decidedAt: decision.decided_at,
      decidedBy: decision.decided_by,
    })),
  };
}

export async function getExpenseApprovalQueue(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  filters: ExpenseListFilters = {}
): Promise<{ reports: ExpenseApprovalQueueItem[]; pagination: ExpensePagination }> {
  const page = resolvePage(filters.page);
  const emptyPagination = { page, pageSize: EXPENSE_PAGE_SIZE, totalCount: 0 };
  if (!context.canApprove && !context.canManage) return { reports: [], pagination: emptyPagination };
  const [start, end] = rangeFor(page);

  // El filtro de estado solo puede acotar la bandeja, nunca ampliarla a
  // rendiciones que no esperan decisión.
  const statuses = filters.status && EXPENSE_PENDING_STATUSES.includes(filters.status)
    ? [filters.status]
    : [...EXPENSE_PENDING_STATUSES];

  let queueQuery = supabase
    .from("expense_reports")
    .select(
      "id, reference_number, title, status, currency_code, total_amount, created_at, submitted_at, submitted_by, profiles!expense_reports_submitted_by_fkey(display_name)",
      { count: "exact" }
    )
    .eq("company_id", context.id)
    .in("status", statuses);
  queueQuery = applyDateWindow(queueQuery, "submitted_at", filters);

  const { data, error, count } = await queueQuery.order("submitted_at", { ascending: true }).range(start, end);
  if (error) throw new Error("No se pudo cargar la bandeja de aprobación.");

  const reports = (data ?? []).map((report) => {
    const profile = unwrapEmbed(report.profiles);
    return {
      id: report.id,
      referenceNumber: report.reference_number,
      title: report.title,
      status: report.status,
      currencyCode: report.currency_code,
      totalAmount: Number(report.total_amount),
      createdAt: report.created_at,
      submittedAt: report.submitted_at,
      isOwn: report.submitted_by === context.userId,
      submitterName: profile?.display_name ?? "Persona de la empresa",
    };
  });

  return { reports, pagination: { page, pageSize: EXPENSE_PAGE_SIZE, totalCount: count ?? reports.length } };
}

export interface ExpenseReconciliationQueueItem extends ExpenseReportSummary {
  submitterName: string;
  paidAt: string | null;
  paymentReference: string | null;
}

/** Estados visibles en la bandeja de conciliación: APPROVED espera pago; PAID queda para consultar la referencia ya registrada. */
export const EXPENSE_RECONCILIATION_STATUSES: readonly ExpenseReportStatus[] = ["APPROVED", "PAID"];

export async function getExpenseReconciliationQueue(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  filters: ExpenseListFilters = {}
): Promise<{ reports: ExpenseReconciliationQueueItem[]; pagination: ExpensePagination }> {
  const page = resolvePage(filters.page);
  const emptyPagination = { page, pageSize: EXPENSE_PAGE_SIZE, totalCount: 0 };
  if (!context.canReconcile && !context.canManage) return { reports: [], pagination: emptyPagination };
  const [start, end] = rangeFor(page);

  // Por defecto solo lo pendiente de pago; filtrar por PAID sirve para
  // volver a ver una referencia ya registrada, nunca amplía a otro estado.
  const statuses = filters.status && EXPENSE_RECONCILIATION_STATUSES.includes(filters.status)
    ? [filters.status]
    : (["APPROVED"] as const);

  let queueQuery = supabase
    .from("expense_reports")
    .select(
      "id, reference_number, title, status, currency_code, total_amount, created_at, submitted_at, submitted_by, paid_at, payment_reference, profiles!expense_reports_submitted_by_fkey(display_name)",
      { count: "exact" }
    )
    .eq("company_id", context.id)
    .in("status", statuses);
  queueQuery = applyDateWindow(queueQuery, "created_at", filters);

  const { data, error, count } = await queueQuery.order("created_at", { ascending: true }).range(start, end);
  if (error) throw new Error("No se pudo cargar la bandeja de conciliación.");

  const reports = (data ?? []).map((report) => {
    const profile = unwrapEmbed(report.profiles);
    return {
      id: report.id,
      referenceNumber: report.reference_number,
      title: report.title,
      status: report.status,
      currencyCode: report.currency_code,
      totalAmount: Number(report.total_amount),
      createdAt: report.created_at,
      submittedAt: report.submitted_at,
      isOwn: report.submitted_by === context.userId,
      submitterName: profile?.display_name ?? "Persona de la empresa",
      paidAt: report.paid_at,
      paymentReference: report.payment_reference,
    };
  });

  return { reports, pagination: { page, pageSize: EXPENSE_PAGE_SIZE, totalCount: count ?? reports.length } };
}

export interface ExpensePolicySettings {
  policyId: string | null;
  categoryLimits: Record<string, number>;
  secondApproverThreshold: number | null;
  mileageRatePerKm: number | null;
  categories: ExpenseCategoryOption[];
}

function parseCategoryLimits(rules: unknown): Record<string, number> {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return {};
  const raw = (rules as Record<string, unknown>).categoryLimits;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
  );
}

function parseSecondApproverThreshold(rules: unknown): number | null {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return null;
  const raw = (rules as Record<string, unknown>).secondApproverThreshold;
  return typeof raw === "number" && raw > 0 ? raw : null;
}

function parseMileageRatePerKm(rules: unknown): number | null {
  if (!rules || typeof rules !== "object" || Array.isArray(rules)) return null;
  const raw = (rules as Record<string, unknown>).mileageRatePerKm;
  return typeof raw === "number" && raw > 0 ? raw : null;
}

/**
 * Primer uso real de expense_policies.rules (EX-5): monto máximo por
 * categoría y umbral que exige un segundo aprobador. Sin política activa,
 * no hay límites ni segundo paso -- comportamiento retrocompatible con toda
 * empresa que activó Rendiciones antes de esto.
 */
/** Solo la tarifa de kilometraje vigente -- más liviano que getExpensePolicySettings cuando no hace falta el resto (categorías, límites). */
export async function getMileageRatePerKm(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext
): Promise<number | null> {
  const { data, error } = await supabase.from("expense_policies").select("rules").eq("company_id", context.id).eq("active", true).maybeSingle();
  if (error) throw new Error("No se pudo cargar la tarifa de kilometraje.");
  return parseMileageRatePerKm(data?.rules);
}

export async function getExpensePolicySettings(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext
): Promise<ExpensePolicySettings> {
  const [policyResult, categoriesResult] = await Promise.all([
    supabase.from("expense_policies").select("id, rules").eq("company_id", context.id).eq("active", true).maybeSingle(),
    supabase.from("expense_categories").select("id, name, requires_receipt").eq("company_id", context.id).eq("active", true).order("name"),
  ]);
  if (policyResult.error || categoriesResult.error) throw new Error("No se pudo cargar la configuración de políticas.");

  return {
    policyId: policyResult.data?.id ?? null,
    categoryLimits: parseCategoryLimits(policyResult.data?.rules),
    secondApproverThreshold: parseSecondApproverThreshold(policyResult.data?.rules),
    mileageRatePerKm: parseMileageRatePerKm(policyResult.data?.rules),
    categories: (categoriesResult.data ?? []).map((category) => ({
      id: category.id,
      name: category.name,
      requiresReceipt: category.requires_receipt,
    })),
  };
}

/**
 * Miembros activos de la empresa, para el selector de destinatario al
 * otorgar un anticipo -- grant_expense_advance() igual revalida esto en el
 * servidor (23503 si ya no es miembro activo), esto es solo para poblar el
 * formulario.
 */
export async function getCompanyMembersForAdvances(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext
): Promise<Array<{ id: string; displayName: string }>> {
  const { data, error } = await supabase
    .from("company_memberships")
    .select("user_id, profiles!company_memberships_user_id_fkey(display_name)")
    .eq("company_id", context.id)
    .eq("active", true);
  if (error) throw new Error("No se pudo cargar la lista de personas de la empresa.");

  return (data ?? [])
    .map((membership) => ({ id: membership.user_id, displayName: unwrapEmbed(membership.profiles)?.display_name ?? "Persona sin nombre registrado" }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "es"));
}

export type ExpenseAdvanceStatus = Database["public"]["Enums"]["expense_advance_status"];

export interface ExpenseAdvance {
  id: string;
  recipientId: string;
  recipientName: string;
  amount: number;
  currencyCode: string;
  purpose: string;
  status: ExpenseAdvanceStatus;
  grantedAt: string;
  settledAt: string | null;
  cancelledAt: string | null;
}

/**
 * Lista de anticipos visible según RLS (EX-7): finanzas ve todos los de la
 * empresa, cualquier otra persona solo los que le otorgaron a ella misma --
 * no hace falta duplicar ese filtro acá, la policy de expense_advances ya
 * lo aplica.
 */
export async function getExpenseAdvances(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext
): Promise<ExpenseAdvance[]> {
  const { data, error } = await supabase
    .from("expense_advances")
    .select("id, recipient_id, amount, currency_code, purpose, status, granted_at, settled_at, cancelled_at, profiles!expense_advances_recipient_id_fkey(display_name)")
    .eq("company_id", context.id)
    .order("granted_at", { ascending: false });
  if (error) throw new Error("No se pudieron cargar los anticipos.");

  return (data ?? []).map((advance) => ({
    id: advance.id,
    recipientId: advance.recipient_id,
    recipientName: unwrapEmbed(advance.profiles)?.display_name ?? "Persona de la empresa",
    amount: Number(advance.amount),
    currencyCode: advance.currency_code,
    purpose: advance.purpose,
    status: advance.status,
    grantedAt: advance.granted_at,
    settledAt: advance.settled_at,
    cancelledAt: advance.cancelled_at,
  }));
}

/**
 * Anticipos PENDIENTES del propio usuario en una moneda dada -- la lista que
 * ve el selector de "vincular anticipo" al armar una rendición en borrador.
 */
export interface ExpenseAdvanceOption {
  id: string;
  amount: number;
  purpose: string;
  grantedAt: string;
  status: ExpenseAdvanceStatus;
}

/**
 * Anticipos PENDIENTES del propio usuario en una moneda dada, MÁS -- si se
 * pasa `includeAdvanceId` -- ese anticipo puntual sin importar su estado
 * actual. Sin esto, si el anticipo ya vinculado a un borrador se cierra o
 * cancela mientras el borrador sigue abierto, dejaría de aparecer en la
 * lista de opciones: el <select> del formulario perdería su
 * defaultValue (ningún <option> coincidiría) y caería al primero ("Sin
 * anticipo"), arriesgando una desvinculación silenciosa si la persona
 * guarda sin fijarse. Incluirlo siempre como opción (marcado si ya no está
 * pendiente) mantiene la selección visible y explícita.
 */
export async function getOwnPendingExpenseAdvances(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  currencyCode: string,
  includeAdvanceId?: string | null
): Promise<ExpenseAdvanceOption[]> {
  let query = supabase
    .from("expense_advances")
    .select("id, amount, purpose, granted_at, status")
    .eq("company_id", context.id)
    .eq("recipient_id", context.userId)
    .eq("currency_code", currencyCode);
  query = includeAdvanceId ? query.or(`status.eq.PENDING,id.eq.${includeAdvanceId}`) : query.eq("status", "PENDING");

  const { data, error } = await query.order("granted_at", { ascending: false });
  if (error) throw new Error("No se pudieron cargar tus anticipos pendientes.");

  return (data ?? []).map((advance) => ({
    id: advance.id,
    amount: Number(advance.amount),
    purpose: advance.purpose,
    grantedAt: advance.granted_at,
    status: advance.status,
  }));
}

// ---------------------------------------------------------------------------
// EX-13 (parte 1): indicadores de gasto, tiempos de aprobación y desglose
// por categoría -- deliberadamente calculados en TypeScript a partir de
// consultas normales (que ya respetan RLS), sin RPC nuevo: son agregaciones
// de solo lectura sobre datos que expense_reports_read/expense_items_read
// ya exponen a quien tiene expenses.read/approve/manage, y no justifican
// una función de base de datos para esta primera pasada.

export interface ExpenseIndicators {
  windowDays: number;
  resolvedCount: number;
  approvedCount: number;
  rejectedCount: number;
  /** null si no hubo ninguna rendición resuelta en la ventana. */
  avgApprovalHours: number | null;
  categoryBreakdown: Array<{ categoryName: string; currencyCode: string; totalAmount: number; itemCount: number }>;
}

/**
 * Visible solo a quien puede ver el panorama completo de la empresa
 * (expenses.read/approve/manage/reconcile) -- un supervisor con solo
 * expenses.submit ve sus propias rendiciones, no indicadores agregados de
 * toda la empresa.
 */
export async function getExpenseIndicators(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  windowDays = 90
): Promise<ExpenseIndicators | null> {
  // canReconcile NO alcanza acá: la RLS de expense_reports/expense_items
  // (expense_reports_read) solo concede visibilidad de TODA la empresa a
  // expenses.read/approve/manage (más las filas propias por submitted_by) --
  // expenses.reconcile no está en esa policy. Pedirlo igual devolvería un
  // "0 rendiciones" silencioso para un rol reconcile-only en vez de negar el
  // acceso, así que el gate de esta función solo pide los permisos que la
  // RLS realmente honra.
  if (!context.canReadAll && !context.canApprove && !context.canManage) return null;

  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const [reportsResult, itemsResult] = await Promise.all([
    supabase
      .from("expense_reports")
      .select("status, submitted_at, resolved_at")
      .eq("company_id", context.id)
      .in("status", ["APPROVED", "REJECTED", "PAID"])
      .gte("resolved_at", sinceIso),
    // "Gasto por categoría" es gasto REAL: solo ítems de rendiciones
    // aprobadas o pagadas, resueltas dentro de la ventana -- un borrador
    // nunca enviado o una rendición rechazada no es gasto de la empresa,
    // aunque la fila exista en expense_items.
    supabase
      .from("expense_items")
      .select("total_amount, currency_code, category_id, expense_categories(name), expense_reports!inner(company_id, status, resolved_at)")
      .eq("company_id", context.id)
      .in("expense_reports.status", ["APPROVED", "PAID"])
      .gte("expense_reports.resolved_at", sinceIso),
  ]);
  if (reportsResult.error || itemsResult.error) throw new Error("No se pudieron cargar los indicadores.");

  const reports = reportsResult.data ?? [];
  const approvalDurationsHours = reports
    .filter((report) => report.submitted_at && report.resolved_at)
    .map((report) => (new Date(report.resolved_at!).getTime() - new Date(report.submitted_at!).getTime()) / (1000 * 60 * 60));
  const avgApprovalHours = approvalDurationsHours.length > 0
    ? approvalDurationsHours.reduce((sum, hours) => sum + hours, 0) / approvalDurationsHours.length
    : null;

  const breakdownByKey = new Map<string, { categoryName: string; currencyCode: string; totalAmount: number; itemCount: number }>();
  for (const item of itemsResult.data ?? []) {
    const categoryName = unwrapEmbed(item.expense_categories)?.name ?? "Sin categoría";
    const key = `${categoryName}::${item.currency_code}`;
    const existing = breakdownByKey.get(key);
    if (existing) {
      existing.totalAmount += Number(item.total_amount ?? 0);
      existing.itemCount += 1;
    } else {
      breakdownByKey.set(key, { categoryName, currencyCode: item.currency_code, totalAmount: Number(item.total_amount ?? 0), itemCount: 1 });
    }
  }

  return {
    windowDays,
    resolvedCount: reports.length,
    approvedCount: reports.filter((report) => report.status === "APPROVED" || report.status === "PAID").length,
    rejectedCount: reports.filter((report) => report.status === "REJECTED").length,
    avgApprovalHours,
    categoryBreakdown: [...breakdownByKey.values()].sort((a, b) => b.totalAmount - a.totalAmount),
  };
}

export interface ExpenseOrganizationUnitOption {
  id: string;
  name: string;
  code: string;
}

/**
 * Unidades organizacionales activas de la empresa, para el selector de
 * centro de costo. Antes de 20260902100000, organization_units solo era
 * legible con el permiso de control plane 'organization.view' -- esa
 * migración agregó una condición de lectura adicional para
 * expenses.submit/expenses.manage, exclusivamente de lectura.
 */
/**
 * `includeUnitId` -- si se pasa -- se incluye sin importar su estado
 * `active`, igual que `includeAdvanceId` en getOwnPendingExpenseAdvances:
 * el centro de costo ya guardado en la rendición no puede desaparecer de
 * las opciones solo porque se desactivó después de asignarse, o el
 * <select> pierde su defaultValue y cae a "Sin centro de costo" -- guardar
 * sin darse cuenta borraría la asignación existente.
 */
export async function getActiveOrganizationUnits(
  supabase: SupabaseClient<Database>,
  context: ExpenseCompanyContext,
  includeUnitId?: string | null
): Promise<ExpenseOrganizationUnitOption[]> {
  let query = supabase.from("organization_units").select("id, name, code").eq("company_id", context.id);
  query = includeUnitId ? query.or(`active.eq.true,id.eq.${includeUnitId}`) : query.eq("active", true);

  const { data, error } = await query.order("name");
  if (error) throw new Error("No se pudieron cargar los centros de costo.");
  return data ?? [];
}
