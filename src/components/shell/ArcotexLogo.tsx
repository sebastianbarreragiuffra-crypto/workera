/**
 * Marca ARCOTEX (Fase 8B.1) -- recreación vectorial de las dos líneas
 * curvas superpuestas del logo real, adaptada a fondo oscuro (sidebar azul
 * marino) para mantener contraste. Nunca un archivo raster externo -- SVG
 * inline, sin dependencias.
 */
export function ArcotexLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 28"
      className={className}
      role="img"
      aria-label="Arcotex"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2 24C10 6 24 -2 32 -2C40 -2 54 6 62 24"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M0 22C9 3 24 -4 32 -4C40 -4 55 3 64 22"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
