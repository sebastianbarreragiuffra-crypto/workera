import { Badge } from "../shell/Badge";
import { EmptyState } from "../shell/StateMessages";
import { SectionCard } from "../shell/SectionCard";
import type { OrganizationUnitKind, OrganizationUnitNode } from "./types";

const UNIT_LABEL: Record<OrganizationUnitKind, string> = {
  COMPANY: "Empresa",
  DIVISION: "División",
  AREA: "Área",
  DEPARTMENT: "Departamento",
  TEAM: "Equipo",
  OTHER: "Unidad",
};

function OrganizationNodeCard({ node, depth }: { node: OrganizationUnitNode; depth: number }) {
  return (
    <li>
      <article className="rounded-lg border border-border bg-white p-3 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-medium text-slate-900">{node.name}</h3>
              <Badge label={UNIT_LABEL[node.kind]} tone={node.kind === "COMPANY" ? "info" : "neutral"} />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {node.leaderName ? `Responsable: ${node.leaderName}` : node.hasLeader ? "Responsable asignado" : "Sin responsable asignado"}
            </p>
          </div>
          <div className="shrink-0 rounded-md bg-slate-50 px-3 py-2 text-left sm:text-right">
            <div className="text-sm font-semibold tabular-nums text-slate-800">{node.memberCount}</div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{node.memberCount === 1 ? "integrante" : "integrantes"}</div>
          </div>
        </div>
      </article>

      {node.children.length > 0 && (
        <ul className={`mt-2 space-y-2 border-l-2 border-slate-200 pl-3 sm:pl-5 ${depth === 0 ? "ml-4" : "ml-2"}`}>
          {node.children.map((child) => <OrganizationNodeCard key={child.id} node={child} depth={depth + 1} />)}
        </ul>
      )}
    </li>
  );
}

export function OrganizationTree({ roots, title = "Estructura organizacional", emptyMessage = "La empresa aún no tiene una estructura organizacional configurada." }: { roots: OrganizationUnitNode[]; title?: string; emptyMessage?: string }) {
  return (
    <SectionCard title={title}>
      {roots.length === 0 ? (
        <EmptyState message={emptyMessage} />
      ) : (
        <ul className="space-y-3" aria-label="Estructura organizacional">
          {roots.map((root) => <OrganizationNodeCard key={root.id} node={root} depth={0} />)}
        </ul>
      )}
    </SectionCard>
  );
}
