export function SearchInput({
  name,
  defaultValue,
  placeholder,
  label,
}: {
  name: string;
  defaultValue?: string;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="max-w-sm">
      <label htmlFor={name} className="sr-only">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="search"
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-arcotex-blue"
      />
    </div>
  );
}
