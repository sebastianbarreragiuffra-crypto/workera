"use client";

import { useState } from "react";
import Link from "next/link";
import type { NavItem } from "./nav-config";

export function Sidebar({ items, appName }: { items: NavItem[]; appName: string }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside
      className={`shrink-0 border-r border-slate-200 bg-white transition-[width] duration-150 ${
        collapsed ? "w-16" : "w-64"
      }`}
      aria-label="Navegación principal"
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between px-4 py-4">
          {!collapsed && <span className="text-sm font-semibold text-slate-900">{appName}</span>}
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? "Expandir navegación" : "Colapsar navegación"}
            aria-expanded={!collapsed}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
          </button>
        </div>
        <nav className="flex-1 space-y-1 px-2">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-md px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
              title={item.label}
            >
              {collapsed ? item.label.slice(0, 1) : item.label}
            </Link>
          ))}
        </nav>
      </div>
    </aside>
  );
}
