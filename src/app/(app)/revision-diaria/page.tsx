import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { getDailyReviewBoard, getDailyReviewDetail, sortPendingCards } from "../../../lib/view-models/daily-review-view";
import type { DailyReviewCardViewModel, FilterCounts } from "../../../lib/view-models/daily-review-view";
import { areasVisibleToRole, assertAreaAccessAllowed, AreaAccessError, type AreaCode } from "../../../lib/access/scope";
import { todayInSantiago, previousDate, nextDate, formatDateLong } from "../../../lib/view-models/date-utils";
import { EmptyState, ErrorState } from "../../../components/shell/StateMessages";
import { ReviewDetailPanel } from "./ReviewDetailPanel";
import { CaseCard } from "./CaseCard";

const AREA_LABEL: Record<AreaCode, string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

const FEEDBACK_LABEL: Record<string, string> = {
  "atraso-justificado": "✓ Atraso justificado",
  "atraso-no-justificado": "✓ Atraso registrado como no justificado",
  "ot-aprobada": "✓ Horas extra aprobadas",
  "ot-rechazada": "✓ Horas extra rechazadas",
  "medico-marcado": "✓ Caso marcado como salida médica",
  "medico-confirmado": "✓ Documento confirmado",
  "salida-decidida": "✓ Salida anticipada decidida",
  "licencia-marcada": "✓ Licencia marcada, pendiente de documento",
  "licencia-confirmada": "✓ Licencia confirmada",
  "licencia-disputada": "✓ Caso enviado a revisión de RRHH",
  "documento-adjuntado": "✓ Documento adjuntado",
};

/** Fase 8B.2, PASO 4: "Pendientes" es el filtro por defecto -- esta pantalla es una work queue, no un listado general. */
const DEFAULT_FILTER = "pendientes";

const FILTERS: { key: string; label: string; countKey: keyof FilterCounts }[] = [
  { key: "pendientes", label: "Pendientes", countKey: "pendientes" },
  { key: "todos", label: "Todos", countKey: "todos" },
  { key: "atrasos", label: "Atrasos", countKey: "atrasos" },
  { key: "horas-extra", label: "Horas extra", countKey: "horasExtra" },
  { key: "clock-out", label: "Clock out", countKey: "clockOut" },
  { key: "salida-anticipada", label: "Salida anticipada", countKey: "salidaAnticipada" },
  { key: "ausencias", label: "Ausencias", countKey: "ausencias" },
  { key: "documentos", label: "Documentos", countKey: "documentos" },
  { key: "revisados", label: "Revisados", countKey: "revisados" },
];

const EMPTY_MESSAGE_BY_FILTER: Record<string, string> = {
  atrasos: "No hay atrasos.",
  "horas-extra": "No hay horas extra pendientes.",
  "clock-out": "No hay clock out pendientes.",
  "salida-anticipada": "No hay salidas anticipadas pendientes.",
  ausencias: "No hay ausencias pendientes de confirmar.",
  documentos: "No hay documentos pendientes.",
  revisados: "Todavía no hay casos revisados hoy.",
  todos: "No hay trabajadores en esta área hoy.",
};

function matchesFilter(card: DailyReviewCardViewModel, filter: string): boolean {
  switch (filter) {
    case "pendientes":
      return card.needsReview;
    case "revisados":
      return !card.needsReview;
    case "atrasos":
      return card.categories.includes("LATE");
    case "salida-anticipada":
      return card.categories.includes("EARLY_DEPARTURE");
    case "horas-extra":
      return card.categories.includes("OVERTIME_CANDIDATE");
    case "clock-out":
      return card.categories.includes("MISSING_PUNCH");
    case "ausencias":
      return card.categories.includes("ABSENCE");
    case "documentos":
      return card.categories.includes("LICENSE_DOCUMENT_REQUIRED") || card.categories.includes("MEDICAL_DOCUMENT_REQUIRED");
    default:
      return true;
  }
}

export default async function DailyReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");

  const params = await searchParams;
  const date = params.fecha ?? todayInSantiago();
  const allowedAreas = areasVisibleToRole(profile.role);
  const requestedArea = (params.area as AreaCode | undefined) ?? allowedAreas[0];
  const filter = params.filtro && FILTERS.some((f) => f.key === params.filtro) ? params.filtro : DEFAULT_FILTER;
  const search = params.q?.trim().toLowerCase() ?? "";
  const selectedEmployeeId = params.empleado;
  const feedback = params.hecho;

  try {
    assertAreaAccessAllowed(profile.role, requestedArea);
  } catch (err) {
    if (err instanceof AreaAccessError) {
      return <ErrorState message="No tienes acceso a esta área." retryHref="/revision-diaria" />;
    }
    throw err;
  }

  const supabase = await createClient();

  let board;
  try {
    board = await getDailyReviewBoard(supabase, profile.role, requestedArea, date);
  } catch {
    return <ErrorState retryHref={`/revision-diaria?fecha=${date}&area=${requestedArea}`} />;
  }

  const pendingCards = sortPendingCards(board.cards.filter((c) => c.needsReview));
  const noIssueCards = board.cards.filter((c) => !c.needsReview);

  let filteredCards = filter === "pendientes" ? pendingCards : board.cards.filter((c) => matchesFilter(c, filter));
  if (search) filteredCards = filteredCards.filter((c) => c.displayName.toLowerCase().includes(search));

  let detail = null;
  if (selectedEmployeeId) {
    try {
      detail = await getDailyReviewDetail(supabase, profile.role, selectedEmployeeId, date);
    } catch {
      detail = null;
    }
  }

  const total = board.counts.todos;
  const completed = board.counts.revisados;
  const progressPct = total > 0 ? Math.round((completed / total) * 100) : 100;

  return (
    <div className="space-y-4">
      {feedback && FEEDBACK_LABEL[feedback] && (
        <div role="status" className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-sm font-medium text-success">
          {FEEDBACK_LABEL[feedback]}
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Revisión diaria</h1>
          <p className="text-sm text-slate-500">
            {AREA_LABEL[requestedArea]} · {formatDateLong(date)}
          </p>
        </div>
        <nav aria-label="Navegación de fecha" className="flex items-center gap-2">
          <Link href={`/revision-diaria?fecha=${previousDate(date)}&area=${requestedArea}`} aria-label="Día anterior" className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50">
            ‹
          </Link>
          <Link href={`/revision-diaria?fecha=${todayInSantiago()}&area=${requestedArea}`} className="rounded-md border border-slate-300 px-3 py-1 text-sm text-slate-600 hover:bg-slate-50">
            Hoy
          </Link>
          <Link href={`/revision-diaria?fecha=${nextDate(date)}&area=${requestedArea}`} aria-label="Día siguiente" className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50">
            ›
          </Link>
        </nav>
      </div>

      {allowedAreas.length > 1 && (
        <div role="tablist" aria-label="Área" className="flex gap-2">
          {allowedAreas.map((area) => (
            <Link
              key={area}
              href={`/revision-diaria?fecha=${date}&area=${area}`}
              role="tab"
              aria-selected={area === requestedArea}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                area === requestedArea ? "bg-arcotex-blue text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
              }`}
            >
              {AREA_LABEL[area]}
            </Link>
          ))}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            Revisión del día — {completed} / {total} completados
          </span>
          <span>{progressPct}%</span>
        </div>
        <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-success transition-[width]" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/revision-diaria?fecha=${date}&area=${requestedArea}&filtro=${f.key}`}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f.key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
            }`}
          >
            {f.label} {board.counts[f.countKey]}
          </Link>
        ))}
      </div>

      <form method="get" className="max-w-sm">
        <input type="hidden" name="fecha" value={date} />
        <input type="hidden" name="area" value={requestedArea} />
        <input type="hidden" name="filtro" value={filter} />
        <label htmlFor="q" className="sr-only">
          Buscar trabajador
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={search}
          placeholder="Buscar trabajador…"
          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-arcotex-blue"
        />
      </form>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,38%)_1fr]">
        <div className={selectedEmployeeId ? "hidden lg:block" : ""}>
          {filteredCards.length === 0 ? (
            filter === "pendientes" ? (
              <EmptyState message={`Revisión completada — no quedan casos pendientes para ${AREA_LABEL[requestedArea]} hoy. ${board.counts.revisados} trabajador${board.counts.revisados === 1 ? "" : "es"} revisado${board.counts.revisados === 1 ? "" : "s"}.`} />
            ) : (
              <EmptyState message={EMPTY_MESSAGE_BY_FILTER[filter] ?? "No hay casos que coincidan."} />
            )
          ) : (
            <ul className="space-y-2">
              {filteredCards.map((card) => (
                <CaseCard key={card.employeeId} card={card} date={date} selected={card.employeeId === selectedEmployeeId} />
              ))}
            </ul>
          )}

          {filter === "pendientes" && noIssueCards.length > 0 && (
            <details className="mt-4 rounded-lg border border-border bg-card">
              <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50">
                ✓ Sin novedades ({noIssueCards.length})
              </summary>
              <ul className="space-y-2 border-t border-border p-2">
                {noIssueCards.map((card) => (
                  <CaseCard key={card.employeeId} card={card} date={date} selected={card.employeeId === selectedEmployeeId} />
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className={selectedEmployeeId ? "" : "hidden lg:block"}>
          {selectedEmployeeId ? (
            <div className="space-y-2">
              <Link href={`/revision-diaria?fecha=${date}&area=${requestedArea}&filtro=${filter}`} className="inline-block text-sm text-arcotex-blue hover:underline lg:hidden">
                ← Volver a la lista
              </Link>
              {detail ? (
                <ReviewDetailPanel detail={detail} date={date} area={requestedArea} />
              ) : (
                <ErrorState message="No pudimos cargar el detalle de este trabajador." retryHref={`/revision-diaria?fecha=${date}&area=${requestedArea}`} />
              )}
            </div>
          ) : (
            <div className="hidden items-center justify-center rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-slate-400 lg:flex">
              Selecciona un caso de la lista para ver el detalle.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
