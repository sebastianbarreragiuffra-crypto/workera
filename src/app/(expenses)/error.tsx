"use client";

import { GestoraBrand } from "@/components/platform/GestoraBrand";

/**
 * Frontera de error de TODO el grupo de rutas de Rendiciones. Cubre los dos
 * puntos que no puede cubrir una frontera dentro de `rendiciones/`:
 *
 *  - `rendiciones/layout.tsx`, que resuelve contexto de empresa y lista de
 *    empresas con consultas que lanzan explícitamente si fallan (una
 *    frontera declarada dentro de un segmento no captura lo que lanza el
 *    layout de ese mismo segmento).
 *  - `/rendiciones`, el selector de empresa, que llama a la misma
 *    `listExpenseCompaniesFromClient()` -- y que además es el destino de
 *    los enlaces de recuperación de las pantallas de 404, así que quedarse
 *    sin frontera acá haría que el camino de salida cayera en la pantalla
 *    cruda de Next justo durante la falla que estas pantallas manejan.
 *
 * Usa `retry()`, no `reset()`: en Next 16.3 `reset()` solo limpia el estado
 * del boundary y re-renderiza el MISMO payload ya fallido, mientras que
 * `retry()` vuelve a pedir los datos al servidor (prop estable desde
 * 16.3.0). Ver node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/error.md.
 */
export default function ExpensesGroupError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="bg-arcotex-navy px-6 py-4">
        <GestoraBrand inverse />
      </header>
      <main className="mx-auto max-w-xl px-4 py-16">
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center">
          <h1 className="text-lg font-semibold text-red-900">No pudimos abrir Rendiciones</h1>
          <p className="mt-2 text-sm text-red-700">
            No se mostraron datos parciales: el acceso sigue protegido. Puedes volver a intentarlo.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            className="mt-4 rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
          >
            Reintentar
          </button>
        </div>
      </main>
    </div>
  );
}
