import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { getDailyReviewBoard, getDailyReviewDetail, sortPendingCards } from "../../../lib/view-models/daily-review-view";
import type { DailyReviewCardViewModel, FilterCounts } from "../../../lib/view-models/daily-review-view";
import { areasVisibleToRole, assertAreaAccessAllowed, parseAreaCode, AreaAccessError, type AreaCode } from "../../../lib/access/scope";
import { todayInSantiago, previousDate, nextDate, formatDateLong, isCalendarDate } from "../../../lib/view-models/date-utils";
import { EmptyState, ErrorState } from "../../../components/shell/StateMessages";
import { ReviewDetailPanel } from "./ReviewDetailPanel";
import { CaseCard } from "./CaseCard";
import { PageHeader } from "../../../components/shell/PageHeader";
import { FilterBar, type FilterOption } from "../../../components/shell/FilterBar";
import { SearchInput } from "../../../components/shell/SearchInput";

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
  "marcacion-corregida": "✓ Marcación corregida — atraso y horas extra recalculados",
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

function buildReviewHref({ date, area, filter, search, employeeId }: { date: string; area: AreaCode; filter?: string; search?: string; employeeId?: string }) {
  const query = new URLSearchParams({ fecha: date, area });
  if (filter) query.set("filtro", filter);
  if (search) query.set("q", search);
  if (employeeId) query.set("empleado", employeeId);
  return `/revision-diaria?${query.toString()}`;
}

export default async function DailyReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");

  const params = await searchParams;
  // `fecha` viene de la URL. Postgres acepta "2026-8-17" sin ceros y la
  // consulta responde bien, pero `formatDateLong` (línea ~163) exige
  // YYYY-MM-DD y lanza: sin este filtro la página cae con un 500 provocable
  // desde la barra de direcciones.
  const date = params.fecha && isCalendarDate(params.fecha) ? params.fecha : todayInSantiago();
  const allowedAreas = areasVisibleToRole(profile.role);
  // Un área desconocida cae al área por defecto del rol, en vez de propagarse
  // hasta `assertAreaAccessAllowed` y mostrar "no tienes acceso" por un typo.
  const requestedArea = parseAreaCode(params.area) ?? allowedAreas[0];
  const filter = params.filtro && FILTERS.some((f) => f.key === params.filtro) ? params.filtro : DEFAULT_FILTER;
  const search = params.q?.trim().toLowerCase() ?? "";
  const requestedEmployeeId = params.empleado;
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

  const selectedCard = requestedEmployeeId ? board.cards.find((card) => card.employeeId === requestedEmployeeId) : undefined;
  const selectedMatchesSearch = !search || selectedCard?.displayName.toLowerCase().includes(search);
  const selectedMatchesFilter = selectedCard && (filter === "pendientes" || matchesFilter(selectedCard, filter));
  const selectedEmployeeId = selectedCard && selectedMatchesSearch && selectedMatchesFilter ? selectedCard.employeeId : undefined;

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

      <PageHeader
        title="Pendientes"
        subtitle={`${AREA_LABEL[requestedArea]} · ${formatDateLong(date)}`}
        actions={<nav aria-label="Navegación de fecha" className="flex items-center gap-2">
          <Link href={`/revision-diaria?fecha=${previousDate(date)}&area=${requestedArea}`} aria-label="Día anterior" className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50">
            ‹
          </Link>
          <Link href={`/revision-diaria?fecha=${todayInSantiago()}&area=${requestedArea}`} className="rounded-md border border-slate-300 px-3 py-1 text-sm text-slate-600 hover:bg-slate-50">
            Hoy
          </Link>
          <Link href={`/revision-diaria?fecha=${nextDate(date)}&area=${requestedArea}`} aria-label="Día siguiente" className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50">
            ›
          </Link>
        </nav>}
      />

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

      <FilterBar
        options={FILTERS.map<FilterOption>((item) => {
          const keepEmployee = selectedCard && (item.key === "pendientes" || matchesFilter(selectedCard, item.key)) && selectedMatchesSearch;
          return {
            key: item.key,
            label: item.label,
            count: board.counts[item.countKey],
            active: filter === item.key,
            href: buildReviewHref({ date, area: requestedArea, filter: item.key, search, employeeId: keepEmployee ? selectedCard.employeeId : undefined }),
          };
        })}
      />

      <form method="get" className="max-w-sm">
        <input type="hidden" name="fecha" value={date} />
        <input type="hidden" name="area" value={requestedArea} />
        <input type="hidden" name="filtro" value={filter} />
        {selectedEmployeeId && <input type="hidden" name="empleado" value={selectedEmployeeId} />}
        <SearchInput name="q" defaultValue={search} placeholder="Buscar trabajador…" label="Buscar trabajador" />
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
                <CaseCard key={card.employeeId} card={card} date={date} filter={filter} search={search} selected={card.employeeId === selectedEmployeeId} />
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
                  <CaseCard key={card.employeeId} card={card} date={date} filter={filter} search={search} selected={card.employeeId === selectedEmployeeId} />
                ))}
              </ul>
            </details>
          )}
        </div>

        <div className={selectedEmployeeId ? "" : "hidden lg:block"}>
          {selectedEmployeeId ? (
            <div className="space-y-2">
              <Link href={buildReviewHref({ date, area: requestedArea, filter, search })} className="inline-block text-sm text-arcotex-blue hover:underline lg:hidden">
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
