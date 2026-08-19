"use client";

import { useState } from "react";
import Link from "next/link";
import { ArcotexLogo } from "./ArcotexLogo";
import type { NavSection } from "./nav-config";
import type { PeriodWindow } from "../../lib/view-models/dashboard-view";

function formatShortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

function PeriodBadge({ label, window }: { label: string; window: PeriodWindow | null }) {
  return (
    <div className="text-xs">
      <div className="text-slate-400">{label}</div>
      {window ? (
        <>
          <div className="font-medium text-slate-200">
            {formatShortDate(window.start)}–{formatShortDate(window.end)}
          </div>
          <div className="mt-0.5 inline-block rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-300">
            {window.status}
          </div>
        </>
      ) : (
        <div className="text-slate-500">Sin período configurado</div>
      )}
    </div>
  );
}

export function Sidebar({
  sections,
  weeklyReview,
  reportingPeriod,
  displayName,
  roleLabel,
  areaLabel,
}: {
  sections: NavSection[];
  weeklyReview: PeriodWindow | null;
  reportingPeriod: PeriodWindow | null;
  displayName: string;
  roleLabel: string;
  areaLabel: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);

  /**
   * Fase 8B.1, PASO 12: en mobile/tablet angosto el sidebar SIEMPRE queda
   * en modo icono (w-16) sin importar el toggle, para nunca causar overflow
   * horizontal de página completa (`md:` = 768px+). El toggle manual
   * (`collapsed`) solo tiene efecto real desde `md:` hacia arriba.
   */
  const widthClass = collapsed ? "w-16" : "w-16 md:w-64";
  const expandedContentClass = collapsed ? "hidden" : "hidden md:block";

  return (
    <aside className={`flex shrink-0 flex-col bg-arcotex-navy transition-[width] duration-150 ${widthClass}`} aria-label="Navegación principal">
      <div className="flex items-center gap-2 px-4 py-4">
        <ArcotexLogo className="h-6 w-14 shrink-0 text-white" />
        <div className={`min-w-0 ${expandedContentClass}`}>
          <div className="text-sm font-bold tracking-wide text-white">ARCOTEX</div>
          <div className="truncate text-[10px] font-medium uppercase tracking-wider text-slate-400">Control de asistencia</div>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expandir navegación" : "Colapsar navegación"}
          aria-expanded={!collapsed}
          className="ml-auto hidden h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white md:flex"
        >
          <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
        </button>
      </div>

      <div className={`mx-3 mb-2 rounded-md bg-white/5 px-3 py-2.5 ${expandedContentClass}`}>
        <div className="truncate text-sm font-medium text-white">{displayName}</div>
        <div className="truncate text-xs text-slate-400">{roleLabel}</div>
        {areaLabel && (
          <span className="mt-1.5 inline-block rounded-full bg-arcotex-blue/20 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-200">
            {areaLabel}
          </span>
        )}
      </div>

      <nav className="flex-1 space-y-4 overflow-y-auto px-2 pb-4">
        {sections.map((section, i) => (
          <div key={section.heading ?? i}>
            {section.heading && (
              <div className={`px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 ${expandedContentClass}`}>
                {section.heading}
              </div>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) =>
                item.comingSoon ? (
                  <div
                    key={item.label}
                    className="flex items-center justify-between rounded-md px-3 py-2 text-sm text-slate-500"
                    title={`${item.label} (Próximamente)`}
                  >
                    <span className={expandedContentClass}>{item.label}</span>
                    <span className={`rounded-full bg-white/5 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-400 ${expandedContentClass}`}>
                      Próximamente
                    </span>
                    <span className={collapsed ? "text-xs" : "text-xs md:hidden"}>{item.label.slice(0, 1)}</span>
                  </div>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="block rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                    title={item.label}
                  >
                    <span className={expandedContentClass}>{item.label}</span>
                    <span className={collapsed ? "" : "md:hidden"}>{item.label.slice(0, 1)}</span>
                  </Link>
                )
              )}
            </div>
          </div>
        ))}
      </nav>

      <div className={`space-y-3 border-t border-white/10 px-4 py-3 ${expandedContentClass}`}>
        <PeriodBadge label="Semana actual" window={weeklyReview} />
        <PeriodBadge label="Período actual" window={reportingPeriod} />
      </div>
    </aside>
  );
}
