"use client";

export default function PlatformError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto max-w-xl rounded-xl border border-red-200 bg-red-50 p-6 text-center">
      <h1 className="text-lg font-semibold text-red-900">No pudimos cargar el control plane</h1>
      <p className="mt-2 text-sm text-red-700">El acceso está protegido y no se mostraron datos parciales. Puedes volver a intentarlo.</p>
      <button type="button" onClick={reset} className="mt-4 rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800">
        Reintentar
      </button>
    </div>
  );
}
