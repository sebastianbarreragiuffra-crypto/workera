"use client";

/**
 * Usa `retry()`, no `reset()`: en Next 16.3 `reset()` solo limpia el estado
 * del boundary y re-renderiza el MISMO payload ya fallido -- el botón no
 * recuperaba nada ante una caída de consulta. `retry()` vuelve a pedir los
 * datos al servidor (prop estable desde 16.3.0). Ver
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md.
 */
export default function PlatformError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-xl rounded-xl border border-red-200 bg-red-50 p-6 text-center">
      <h1 className="text-lg font-semibold text-red-900">No pudimos cargar el control plane</h1>
      <p className="mt-2 text-sm text-red-700">El acceso está protegido y no se mostraron datos parciales. Puedes volver a intentarlo.</p>
      <button type="button" onClick={() => retry()} className="mt-4 rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">
        Reintentar
      </button>
    </div>
  );
}
