import { redirect } from "next/navigation";
import { createClient } from "../../../lib/supabase/server";
import { getCurrentProfile } from "../../../lib/auth/session";
import { getEmployeeRoster } from "../../../lib/view-models/employees-view";
import { areasVisibleToRole, type AreaCode } from "../../../lib/access/scope";
import { todayInSantiago } from "../../../lib/view-models/date-utils";
import { EmptyState, ErrorState } from "../../../components/shell/StateMessages";

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

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Empleados</h1>
        <p className="text-sm text-slate-500">{roster.length} trabajador{roster.length === 1 ? "" : "es"}</p>
      </div>

      {allowedAreas.length > 1 && (
        <div className="flex gap-2">
          <a
            href="/empleados"
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${!areaFilter ? "bg-blue-600 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300"}`}
          >
            Todos
          </a>
          {allowedAreas.map((area) => (
            <a
              key={area}
              href={`/empleados?area=${area}`}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${areaFilter === area ? "bg-blue-600 text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300"}`}
            >
              {AREA_LABEL[area]}
            </a>
          ))}
        </div>
      )}

      <form method="get" className="max-w-sm">
        {areaFilter && <input type="hidden" name="area" value={areaFilter} />}
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
                <tr key={employee.employeeId} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-medium text-slate-900">{employee.displayName}</td>
                  <td className="px-4 py-3 text-slate-600">{employee.areaCode ? AREA_LABEL[employee.areaCode] : "Sin área"}</td>
                  <td className="px-4 py-3 text-slate-600">{employee.active ? "Activo" : "Inactivo"}</td>
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
