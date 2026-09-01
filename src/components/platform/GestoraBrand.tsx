export interface GestoraBrandProps {
  inverse?: boolean;
  compact?: boolean;
  subtitle?: string;
  className?: string;
}

/** Marca vectorial liviana para el control plane; no requiere assets ni JS cliente. */
export function GestoraBrand({
  inverse = false,
  compact = false,
  subtitle = "Administración multiempresa",
  className = "",
}: GestoraBrandProps) {
  const primary = inverse ? "text-white" : "text-arcotex-navy";
  const secondary = inverse ? "text-blue-200" : "text-arcotex-blue";
  const muted = inverse ? "text-slate-400" : "text-slate-500";

  return (
    <div className={`inline-flex min-w-0 items-center gap-2.5 ${className}`} aria-label="GESTORA">
      <svg
        viewBox="0 0 40 40"
        className={`h-9 w-9 shrink-0 ${secondary}`}
        role="img"
        aria-label="Isotipo GESTORA"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect x="3" y="3" width="34" height="34" rx="10" fill="currentColor" />
        <path d="M27.5 14.5A10 10 0 1 0 28 25h-7v-5h12" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>

      {!compact && (
        <div className="min-w-0 leading-none">
          <div className={`truncate text-sm font-bold tracking-[0.18em] ${primary}`}>GESTORA</div>
          <div className={`mt-1 truncate text-[10px] font-medium uppercase tracking-wider ${muted}`}>{subtitle}</div>
        </div>
      )}
    </div>
  );
}
