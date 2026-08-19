import Link from "next/link";

/**
 * Estados reutilizables (Fase 8, PASO "Loading / Empty / Error"). Nunca
 * exponen stack traces ni payloads -- el mensaje de error es siempre
 * genérico, la causa real solo queda en logs de servidor.
 */

export function EmptyState({ message }: { message: string }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      ✓ {message}
    </div>
  );
}

export function ErrorState({ message = "No pudimos cargar esta información.", retryHref }: { message?: string; retryHref: string }) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-8 text-center">
      <p className="text-sm text-red-700">{message}</p>
      <Link
        href={retryHref}
        className="mt-3 inline-block rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
      >
        Reintentar
      </Link>
    </div>
  );
}
