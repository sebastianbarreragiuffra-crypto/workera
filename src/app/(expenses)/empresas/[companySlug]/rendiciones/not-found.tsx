import Link from "next/link";

/**
 * 404 de RECURSO dentro de Rendiciones, renderizado dentro de ExpenseShell:
 * una rendición que no existe o que no es visible con tus permisos, un
 * comprobante inexistente, o una pantalla (Indicadores, Políticas) que tu
 * rol no puede ver.
 *
 * No dice cuál de esas tres cosas ocurrió a propósito: distinguir "no
 * existe" de "existe pero no podés verlo" filtraría la existencia de datos
 * de otra empresa o de otra persona.
 */
export default function ExpenseResourceNotFound() {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-border bg-white p-8 text-center shadow-sm">
      <h1 className="text-lg font-semibold text-slate-900">No encontramos esta pantalla</h1>
      <p className="mt-2 text-sm text-slate-500">
        La rendición no existe o tu rol no tiene acceso a esta sección de la empresa. Usa el menú de arriba para volver
        a una pantalla disponible.
      </p>
      {/* `not-found.tsx` no recibe `params` en el App Router, así que no se
          puede construir el enlace a la empresa actual: se apunta al
          selector, que redirige solo si hay una sola empresa. La navegación
          por empresa ya la ofrece ExpenseShell, que envuelve esta pantalla. */}
      <Link
        href="/rendiciones"
        className="mt-5 inline-flex rounded-md bg-arcotex-blue px-4 py-2 text-sm font-medium text-white hover:bg-arcotex-blue-dark"
      >
        Ver mis empresas
      </Link>
    </div>
  );
}
