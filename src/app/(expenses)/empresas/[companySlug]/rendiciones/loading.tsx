/**
 * Skeleton de las páginas de Rendiciones, dentro de ExpenseShell. Varias de
 * estas pantallas resuelven 3-5 consultas en paralelo antes de renderizar
 * (dashboard con KPIs, detalle con ítems + comprobantes + decisiones +
 * anticipos + centros de costo), así que sin esto la navegación se siente
 * congelada. Mismo criterio y forma que `(platform)/plataforma/loading.tsx`.
 *
 * Contrapartida asumida a conciencia: al abrir un Suspense boundary, la
 * respuesta empieza a transmitirse con status 200 antes de que la página
 * llegue a su `notFound()`, así que un 404 de recurso (reportId inexistente,
 * pantalla sin permiso) se sirve como 200 con la UI de `not-found.tsx`
 * (Next agrega `<meta name="robots" content="noindex">` automáticamente).
 * Ver node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/loading.md, sección "Status Codes".
 *
 * Se acepta porque estas rutas son privadas detrás del guard de sesión --
 * ningún crawler las ve, no hay SEO en juego -- y el proyecto no tiene
 * analítica que cuente status codes. Si algún día se necesita el 404 real
 * (cumplimiento o métricas), la doc indica resolverlo antes de transmitir,
 * en `proxy`, no quitando este skeleton.
 */
export default function ExpenseLoading() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Cargando Rendiciones">
      <div className="h-12 w-72 animate-pulse rounded-lg bg-slate-200" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-28 animate-pulse rounded-lg bg-slate-200" />
        ))}
      </div>
      <div className="h-72 animate-pulse rounded-lg bg-slate-200" />
    </div>
  );
}
