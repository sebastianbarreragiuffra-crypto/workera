import Link from "next/link";

export interface FilterOption {
  key: string;
  label: string;
  href: string;
  count?: number;
  active: boolean;
}

export function FilterBar({ options }: { options: FilterOption[] }) {
  return (
    <nav aria-label="Filtros">
      <ul className="flex flex-wrap gap-2">
        {options.map((option) => (
          <li key={option.key}>
            <Link
              href={option.href}
              aria-current={option.active ? "page" : undefined}
              className={`rounded-full px-3 py-1.5 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue ${
                option.active ? "bg-arcotex-navy text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
              }`}
            >
              {option.label}
              {option.count !== undefined && (
                <>
                  <span className="ml-1 opacity-80" aria-hidden="true">
                    {option.count}
                  </span>
                  <span className="sr-only">
                    {option.count === 1 ? " (1 resultado)" : ` (${option.count} resultados)`}
                  </span>
                </>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
