import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { getDailyReviewBoard, getDailyReviewDetail, categoryLabel } from "../../../lib/view-models/daily-review-view";
import type { DailyReviewCardViewModel } from "../../../lib/view-models/daily-review-view";
import { areasVisibleToRole, assertAreaAccessAllowed, AreaAccessError, type AreaCode } from "../../../lib/access/scope";
import { todayInSantiago, previousDate, nextDate, formatDateLong } from "../../../lib/view-models/date-utils";
import { EmptyState, ErrorState } from "../../../components/shell/StateMessages";
import { ReviewDetailPanel } from "./ReviewDetailPanel";

const AREA_LABEL: Record<AreaCode, string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

const FILTERS = [
  { key: "todos", label: "Todos" },
  { key: "pendientes", label: "Pendientes" },
  { key: "revisados", label: "Revisados" },
  { key: "atrasos", label: "Atrasos" },
  { key: "salida-anticipada", label: "Salida anticipada" },
  { key: "horas-extra", label: "Horas extra" },
  { key: "ausencias", label: "Ausencias" },
] as const;

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
    case "ausencias":
      return card.categories.includes("ABSENCE") || card.categories.includes("LICENSE_DOCUMENT_REQUIRED");
    default:
      return true;
  }
}

function ReviewCard({ card, date }: { card: DailyReviewCardViewModel; date: string }) {
  return (
    <li>
      <Link
        href={`/revision-diaria?fecha=${date}&area=${card.areaCode}&empleado=${card.employeeId}`}
        className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-blue-300 hover:shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-900">{card.displayName}</span>
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{AREA_LABEL[card.areaCode]}</span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 text-xs text-slate-500">
          <span>Entrada {card.clockIn ? new Date(card.clockIn).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
          <span>Salida {card.clockOut ? new Date(card.clockOut).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }) : "—"}</span>
        </div>
        {card.categories.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {card.categories.map((c) => (
              <li key={c} className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
                ⚠ {categoryLabel(c)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs font-medium text-green-700">✓ Sin novedades</p>
        )}
        <p className="mt-2 text-xs font-semibold text-slate-600">
          Estado: {card.needsReview ? "REQUIERE REVISIÓN" : "OK"}
        </p>
      </Link>
    </li>
  );
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
  const filter = params.filtro && FILTERS.some((f) => f.key === params.filtro) ? params.filtro : "todos";
  const search = params.q?.trim().toLowerCase() ?? "";
  const selectedEmployeeId = params.empleado;

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

  let filteredCards = board.cards.filter((c) => matchesFilter(c, filter));
  if (search) {
    filteredCards = filteredCards.filter((c) => c.displayName.toLowerCase().includes(search));
  }

  let detail = null;
  if (selectedEmployeeId) {
    try {
      detail = await getDailyReviewDetail(supabase, profile.role, selectedEmployeeId, date);
    } catch {
      detail = null;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Revisión diaria</h1>
          <p className="text-sm text-slate-500">{formatDateLong(date)}</p>
        </div>
        <nav aria-label="Navegación de fecha" className="flex items-center gap-2">
          <Link
            href={`/revision-diaria?fecha=${previousDate(date)}&area=${requestedArea}`}
            aria-label="Día anterior"
            className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
          >
            ‹
          </Link>
          <Link
            href={`/revision-diaria?fecha=${nextDate(date)}&area=${requestedArea}`}
            aria-label="Día siguiente"
            className="rounded-md border border-slate-300 px-2.5 py-1 text-sm text-slate-600 hover:bg-slate-50"
          >
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
                area === requestedArea ? "bg-blue-600 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
              }`}
            >
              {AREA_LABEL[area]}
            </Link>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/revision-diaria?fecha=${date}&area=${requestedArea}&filtro=${f.key}`}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              filter === f.key ? "bg-slate-900 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <form method="get" className="max-w-sm">
        <input type="hidden" name="fecha" value={date} />
        <input type="hidden" name="area" value={requestedArea} />
        <input type="hidden" name="filtro" value={filter} />
        <label htmlFor="q" className="sr-only">
          Buscar empleado
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={search}
          placeholder="Buscar empleado…"
          className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
        />
      </form>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div>
          {filteredCards.length === 0 ? (
            <EmptyState message={`No hay revisiones ${filter === "todos" ? "" : "que coincidan con el filtro "}para ${AREA_LABEL[requestedArea]} hoy.`} />
          ) : (
            <ul className="space-y-3">
              {filteredCards.map((card) => (
                <ReviewCard key={card.employeeId} card={card} date={date} />
              ))}
            </ul>
          )}
        </div>

        {selectedEmployeeId && (
          <div>{detail ? <ReviewDetailPanel detail={detail} date={date} area={requestedArea} /> : <ErrorState message="No pudimos cargar el detalle de este trabajador." retryHref={`/revision-diaria?fecha=${date}&area=${requestedArea}`} />}</div>
        )}
      </div>
    </div>
  );
}
