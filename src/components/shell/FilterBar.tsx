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
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <Link
          key={option.key}
          href={option.href}
          aria-current={option.active ? "true" : undefined}
          className={`rounded-full px-3 py-1.5 text-sm font-medium ${
            option.active ? "bg-arcotex-navy text-white" : "bg-white text-slate-600 ring-1 ring-inset ring-slate-300 hover:bg-slate-50"
          }`}
        >
          {option.label}
          {option.count !== undefined && <span className="ml-1 opacity-80">{option.count}</span>}
        </Link>
      ))}
    </div>
  );
}
