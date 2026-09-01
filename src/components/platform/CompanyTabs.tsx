import Link from "next/link";
import type { CompanyTabItem } from "./types";

export function CompanyTabs({ tabs, ariaLabel = "Secciones de la empresa" }: { tabs: CompanyTabItem[]; ariaLabel?: string }) {
  return (
    <nav aria-label={ariaLabel} className="overflow-x-auto border-b border-border">
      <div className="flex min-w-max gap-1">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={tab.active ? "page" : undefined}
            className={`border-b-2 px-3 py-2.5 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-arcotex-blue ${
              tab.active ? "border-arcotex-blue text-arcotex-blue-dark" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"
            }`}
          >
            {tab.label}
            {tab.count !== undefined && tab.count !== null && <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${tab.active ? "bg-blue-100 text-arcotex-blue-dark" : "bg-slate-100 text-slate-600"}`}>{tab.count}</span>}
          </Link>
        ))}
      </div>
    </nav>
  );
}
