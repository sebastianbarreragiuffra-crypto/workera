"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/plataforma", label: "Dashboard", shortLabel: "D" },
  { href: "/plataforma/empresas", label: "Empresas", shortLabel: "E" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/plataforma") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function PlatformNavigation() {
  const pathname = usePathname();

  return (
    <nav className="space-y-1 px-2" aria-label="Navegación de plataforma">
      {ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            className={`flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${
              active ? "bg-white/12 text-white" : "text-slate-300 hover:bg-white/8 hover:text-white"
            }`}
          >
            <span className="w-5 text-center text-xs font-semibold md:hidden" aria-hidden="true">{item.shortLabel}</span>
            <span className="hidden md:inline">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
