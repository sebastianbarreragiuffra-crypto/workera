import Link from "next/link";
import { EXPENSE_STATUS_LABEL } from "@/lib/expenses/presentation";
import type { ExpenseListFilters, ExpensePagination, ExpenseReportStatus } from "@/lib/expenses/data";

/**
 * Filtros y paginación del historial y de la bandeja de aprobación. Es un
 * Server Component con un `form method="get"`: el estado vive en la URL, así
 * que la página siguiente se resuelve con una consulta acotada en la base y no
 * recortando en memoria un historial ya descargado. Funciona sin JavaScript y
 * los enlaces quedan compartibles.
 */

function withParams(basePath: string, filters: ExpenseListFilters, page: number): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("estado", filters.status);
  if (filters.from) params.set("desde", filters.from);
  if (filters.to) params.set("hasta", filters.to);
  if (page > 1) params.set("pagina", String(page));
  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function ExpenseListFiltersForm({
  filters,
  statuses,
  legend,
}: {
  filters: ExpenseListFilters;
  statuses: readonly ExpenseReportStatus[];
  legend: string;
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4" aria-label={legend}>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Estado
        <select
          name="estado"
          defaultValue={filters.status ?? ""}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
        >
          <option value="">Todos</option>
          {statuses.map((status) => (
            <option key={status} value={status}>
              {EXPENSE_STATUS_LABEL[status]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Desde
        <input type="date" name="desde" defaultValue={filters.from ?? ""} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900" />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
        Hasta
        <input type="date" name="hasta" defaultValue={filters.to ?? ""} className="rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900" />
      </label>
      <button type="submit" className="rounded-md bg-arcotex-blue px-3 py-1.5 text-sm font-medium text-white hover:bg-arcotex-blue-dark">
        Filtrar
      </button>
    </form>
  );
}

export function ExpensePaginationNav({
  basePath,
  filters,
  pagination,
}: {
  basePath: string;
  filters: ExpenseListFilters;
  pagination: ExpensePagination;
}) {
  const totalPages = Math.max(1, Math.ceil(pagination.totalCount / pagination.pageSize));
  if (pagination.totalCount <= pagination.pageSize) return null;

  const first = (pagination.page - 1) * pagination.pageSize + 1;
  const last = Math.min(pagination.page * pagination.pageSize, pagination.totalCount);

  return (
    <nav className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3" aria-label="Paginación">
      <p className="text-xs text-slate-500">
        {first}–{last} de {pagination.totalCount}
      </p>
      <div className="flex items-center gap-2">
        {pagination.page > 1 && (
          <Link
            href={withParams(basePath, filters, pagination.page - 1)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← Anterior
          </Link>
        )}
        <span className="text-xs text-slate-500">
          Página {pagination.page} de {totalPages}
        </span>
        {pagination.page < totalPages && (
          <Link
            href={withParams(basePath, filters, pagination.page + 1)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Siguiente →
          </Link>
        )}
      </div>
    </nav>
  );
}
