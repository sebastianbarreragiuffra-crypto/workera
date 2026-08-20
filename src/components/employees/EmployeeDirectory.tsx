import Link from "next/link";
import { EmptyState } from "../shell/StateMessages";
import { FilterBar, type FilterOption } from "../shell/FilterBar";
import { SearchInput } from "../shell/SearchInput";
import { EmployeeAvatar } from "../shell/EmployeeAvatar";
import { Badge } from "../shell/Badge";
import type { AreaCode } from "../../lib/access/scope";
import type { EmployeeRosterEntry } from "../../lib/view-models/employees-view";

const AREA_LABEL: Record<AreaCode, string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

/**
 * Directorio de empleados -- extraído de la antigua página "Trabajadores"
 * (`/empleados`) para reutilizarlo tal cual, sin reconstruirlo, ahora que
 * "Licencias" es la página consolidada (directorio + licencias). Orden
 * alfabético, búsqueda y separación por área ya los resuelve
 * `getEmployeeRoster` (orden) + `FilterBar` (área, un filtro a la vez -- no
 * se rediseña a 3 columnas simultáneas, mismo comportamiento ya probado).
 * `baseHref` permite que el mismo componente sirva desde cualquier ruta que
 * lo monte (hoy solo `/licencias`) sin hardcodear la URL adentro.
 */
export function EmployeeDirectory({
  roster,
  allowedAreas,
  areaFilter,
  search,
  baseHref,
}: {
  roster: EmployeeRosterEntry[];
  allowedAreas: AreaCode[];
  areaFilter: AreaCode | undefined;
  search: string | undefined;
  baseHref: string;
}) {
  const areaFilterOptions: FilterOption[] =
    allowedAreas.length > 1
      ? [
          { key: "all", label: "Todos", href: baseHref, active: !areaFilter },
          ...allowedAreas.map((area) => ({
            key: area,
            label: AREA_LABEL[area],
            href: `${baseHref}?area=${area}`,
            active: areaFilter === area,
          })),
        ]
      : [];

  return (
    <div className="space-y-3">
      {areaFilterOptions.length > 0 && <FilterBar options={areaFilterOptions} />}

      <form method="get" action={baseHref} className="max-w-sm">
        {areaFilter && <input type="hidden" name="area" value={areaFilter} />}
        <SearchInput name="q" defaultValue={search} placeholder="Buscar empleado…" label="Buscar empleado" />
      </form>

      {roster.length === 0 ? (
        <EmptyState message="No hay empleados que coincidan." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Nombre
                </th>
                <th scope="col" className="px-4 py-3">
                  Área
                </th>
                <th scope="col" className="px-4 py-3">
                  Estado
                </th>
                <th scope="col" className="px-4 py-3">
                  Control horario
                </th>
              </tr>
            </thead>
            <tbody>
              {roster.map((employee) => (
                <tr key={employee.employeeId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <Link href={`/empleados/${employee.employeeId}`} className="flex items-center gap-2 hover:underline">
                      <EmployeeAvatar displayName={employee.displayName} size="sm" />
                      {employee.displayName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{employee.areaCode ? AREA_LABEL[employee.areaCode] : "Sin área"}</td>
                  <td className="px-4 py-3">
                    <Badge label={employee.active ? "Activo" : "Inactivo"} tone={employee.active ? "positive" : "neutral"} />
                  </td>
                  <td className="px-4 py-3 text-slate-600">{employee.timeControl === "EXEMPT" ? "Exento" : "Normal"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
