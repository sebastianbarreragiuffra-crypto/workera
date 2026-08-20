import { redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { getEmployeeRoster } from "../../../lib/view-models/employees-view";
import { areasVisibleToRole, type AreaCode } from "../../../lib/access/scope";
import { todayInSantiago } from "../../../lib/view-models/date-utils";
import { EmptyState, ErrorState } from "../../../components/shell/StateMessages";
import { PageHeader } from "../../../components/shell/PageHeader";
import { FilterBar, type FilterOption } from "../../../components/shell/FilterBar";
import { SearchInput } from "../../../components/shell/SearchInput";
import { EmployeeAvatar } from "../../../components/shell/EmployeeAvatar";
import { Badge } from "../../../components/shell/Badge";

const AREA_LABEL: Record<AreaCode, string> = {
  PRODUCTION: "Producción",
  INSTALLATION: "Instalación",
  ADMINISTRATION: "Administración",
};

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const profile = await getCurrentProfile();
  if (!profile?.role) redirect("/login");

  const allowedAreas = areasVisibleToRole(profile.role);
  const params = await searchParams;
  const areaFilter = params.area as AreaCode | undefined;
  const search = params.q?.trim();

  const supabase = await createClient();

  let roster;
  try {
    roster = await getEmployeeRoster(supabase, profile.role, { areaCode: areaFilter, search }, todayInSantiago());
  } catch {
    return <ErrorState retryHref="/empleados" />;
  }

  const areaFilterOptions: FilterOption[] = allowedAreas.length > 1
    ? [
        { key: "all", label: "Todos", href: "/empleados", active: !areaFilter },
        ...allowedAreas.map((area) => ({
          key: area,
          label: AREA_LABEL[area],
          href: `/empleados?area=${area}`,
          active: areaFilter === area,
        })),
      ]
    : [];

  return (
    <div className="space-y-4">
      <PageHeader title="Empleados" subtitle={`${roster.length} trabajador${roster.length === 1 ? "" : "es"}`} />

      {areaFilterOptions.length > 0 && <FilterBar options={areaFilterOptions} />}

      <form method="get" className="max-w-sm">
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
