export type BadgeTone = "positive" | "negative" | "warning" | "info" | "neutral";

const TONE_CLASS: Record<BadgeTone, string> = {
  positive: "bg-success-bg text-success ring-success-border",
  negative: "bg-critical-bg text-critical ring-critical-border",
  warning: "bg-warning-bg text-warning ring-warning-border",
  info: "bg-info-bg text-info ring-info-border",
  neutral: "bg-slate-100 text-slate-600 ring-slate-300",
};

/** Badge genérico -- nunca depende solo del color, siempre ícono + texto. */
export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONE_CLASS[tone]}`}>
      <span aria-hidden="true">●</span>
      {label}
    </span>
  );
}
