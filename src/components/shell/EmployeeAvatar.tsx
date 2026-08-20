function initialsOf(displayName: string): string {
  const parts = displayName.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}

export function EmployeeAvatar({ displayName, size = "md" }: { displayName: string; size?: "sm" | "md" }) {
  const dimension = size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs";
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-arcotex-blue/10 font-semibold text-arcotex-blue-dark ${dimension}`}
    >
      {initialsOf(displayName)}
    </span>
  );
}
