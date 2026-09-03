"use client";

/**
 * Frontera de error de las PÁGINAS de Rendiciones -- se renderiza dentro de
 * ExpenseShell, así que la persona conserva la navegación del módulo en vez
 * de quedar en una pantalla suelta. Mismo criterio que
 * `(platform)/plataforma/error.tsx`.
 *
 * Cubre lo que lanzan las consultas de `lib/expenses/data.ts` ("No se
 * pudieron cargar las rendiciones", "No se pudo cargar el detalle...", etc.).
 * Los fallos del layout los cubre `(expenses)/error.tsx`, más arriba.
 *
 * Usa `retry()`, no `reset()`: en Next 16.3 `reset()` solo limpia el estado
 * del boundary y re-renderiza el MISMO payload ya fallido, mientras que
 * `retry()` vuelve a pedir los datos al servidor (prop estable desde
 * 16.3.0). Ver node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/error.md.
 */
export default function ExpenseError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-xl rounded-xl border border-red-200 bg-red-50 p-6 text-center">
      <h1 className="text-lg font-semibold text-red-900">No pudimos cargar esta pantalla</h1>
      <p className="mt-2 text-sm text-red-700">
        No se mostraron datos parciales de la empresa. Puedes volver a intentarlo.
      </p>
      <button
        type="button"
        onClick={() => retry()}
        className="mt-4 rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800"
      >
        Reintentar
      </button>
    </div>
  );
}
