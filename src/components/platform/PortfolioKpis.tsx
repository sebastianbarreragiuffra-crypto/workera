import Link from "next/link";
import type { PortfolioKpiItem, PortfolioKpiTone } from "./types";

const TONE_CLASS: Record<PortfolioKpiTone, { accent: string; marker: string }> = {
  neutral: { accent: "border-l-slate-400", marker: "bg-slate-400" },
  positive: { accent: "border-l-success", marker: "bg-success" },
  warning: { accent: "border-l-warning", marker: "bg-warning" },
  negative: { accent: "border-l-critical", marker: "bg-critical" },
  info: { accent: "border-l-arcotex-blue", marker: "bg-arcotex-blue" },
};

function KpiContent({ item }: { item: PortfolioKpiItem }) {
  const tone = TONE_CLASS[item.tone ?? "neutral"];

  return (
    <div className={`h-full rounded-lg border border-border border-l-4 bg-card p-4 shadow-sm ${tone.accent}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{item.label}</p>
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${tone.marker}`} aria-hidden="true" />
      </div>
      <p className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{item.value}</p>
      {item.supportingText && <p className="mt-1 text-xs leading-5 text-slate-500">{item.supportingText}</p>}
    </div>
  );
}

export function PortfolioKpis({ items, ariaLabel = "Indicadores de cartera" }: { items: PortfolioKpiItem[]; ariaLabel?: string }) {
  return (
    <section aria-label={ariaLabel} className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) =>
        item.href ? (
          <Link key={item.id} href={item.href} className="rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue">
            <KpiContent item={item} />
          </Link>
        ) : (
          <KpiContent key={item.id} item={item} />
        )
      )}
    </section>
  );
}
