/** Marca ARCOTEX completa: arcos negros y wordmark azul del logo corporativo. */
export function ArcotexLogo({ className, inverse = false }: { className?: string; inverse?: boolean }) {
  return (
    <svg
      viewBox="0 0 240 105"
      className={className}
      role="img"
      aria-label="Arcotex"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M6 72C26 20 79 2 120 2s94 18 114 70" stroke={inverse ? "#ffffff" : "#111111"} strokeWidth="3.5" />
      <path d="M10 73C30 29 78 11 120 11s90 18 110 62" stroke={inverse ? "#ffffff" : "#111111"} strokeWidth="3.5" />
      <text
        x="120"
        y="94"
        fill={inverse ? "#78c7f3" : "#2f82bb"}
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="48"
        fontWeight="500"
        letterSpacing="-1.5"
        textAnchor="middle"
      >
        ARCOTEX
      </text>
    </svg>
  );
}
