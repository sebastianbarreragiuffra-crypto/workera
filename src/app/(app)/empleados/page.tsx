import { redirect } from "next/navigation";

/**
 * "Trabajadores" ya no es un destino visible del menú -- su directorio se
 * absorbió en "Licencias" (`/licencias`), que ahora reutiliza exactamente
 * la misma consulta/tabla (`EmployeeDirectory`, extraído de esta página sin
 * reconstruirla). Esta ruta se conserva SOLO por estabilidad (enlaces/
 * marcadores antiguos) -- redirige preservando los filtros de área/búsqueda
 * en vez de servir un segundo directorio duplicado. `/empleados/[id]`
 * (detalle de un empleado puntual) no se toca -- sigue siendo una ruta
 * válida y distinta, enlazada desde el propio directorio.
 */
export default async function EmployeesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.area) query.set("area", params.area);
  if (params.q) query.set("q", params.q);
  const suffix = query.toString();
  redirect(`/licencias${suffix ? `?${suffix}` : ""}`);
}
