"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  assignCompanyRoleAction,
  createCompanyAction,
  createOrganizationUnitAction,
  inviteCompanyMemberAction,
  resendCompanyInvitationAction,
  setCompanyModuleStatusAction,
  setOnboardingStepStatusAction,
  type PlatformActionState,
} from "@/app/(platform)/plataforma/actions";
import type { CompanyModuleStatus, CompanyOnboardingStatus, OrganizationUnitKind } from "./types";

const INITIAL_STATE: PlatformActionState = { status: "idle", message: "" };
const INPUT_CLASS =
  "mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-arcotex-blue focus:outline-none focus:ring-2 focus:ring-blue-100";

function SubmitButton({ children, compact = false }: { children: React.ReactNode; compact?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex items-center justify-center rounded-md bg-arcotex-blue font-medium text-white hover:bg-arcotex-blue-dark disabled:cursor-wait disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-arcotex-blue ${compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm"}`}
    >
      {pending ? "Guardando…" : children}
    </button>
  );
}

function ActionFeedback({ state }: { state: PlatformActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      role={state.status === "error" ? "alert" : "status"}
      className={`mt-3 rounded-md px-3 py-2 text-sm ${state.status === "error" ? "bg-critical-bg text-critical" : state.status === "warning" ? "bg-amber-50 text-amber-800" : "bg-success-bg text-success"}`}
    >
      {state.message}
    </p>
  );
}

export function CreateCompanyForm({ canManage }: { canManage: boolean }) {
  const [state, action] = useActionState(createCompanyAction, INITIAL_STATE);

  if (!canManage) {
    return <p className="text-sm text-slate-500">Tu rol permite consultar la cartera, pero no crear empresas.</p>;
  }

  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">
          Nombre comercial
          <input name="name" required minLength={2} maxLength={100} className={INPUT_CLASS} placeholder="Ej. Empresa Andina" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Razón social
          <input name="legalName" maxLength={160} className={INPUT_CLASS} placeholder="Opcional" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Identificador URL
          <input name="slug" maxLength={63} className={INPUT_CLASS} placeholder="Se genera desde el nombre" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Plan
          <select name="planCode" defaultValue="CUSTOM" className={INPUT_CLASS}>
            <option value="CUSTOM">Personalizado</option>
            <option value="STARTER">Starter</option>
            <option value="GROWTH">Growth</option>
            <option value="ENTERPRISE">Enterprise</option>
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Contacto principal
          <input name="primaryContactName" maxLength={120} className={INPUT_CLASS} placeholder="Nombre y apellido" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Correo de contacto
          <input name="primaryContactEmail" type="email" maxLength={254} className={INPUT_CLASS} placeholder="contacto@empresa.cl" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          País (ISO)
          <input name="countryCode" required defaultValue="CL" minLength={2} maxLength={2} pattern="[A-Za-z]{2}" className={INPUT_CLASS} />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Zona horaria
          <input name="timezone" required defaultValue="America/Santiago" list="gestora-timezones" maxLength={80} className={INPUT_CLASS} />
          <datalist id="gestora-timezones">
            <option value="America/Santiago" />
            <option value="America/Lima" />
            <option value="America/Bogota" />
            <option value="America/Mexico_City" />
            <option value="America/Argentina/Buenos_Aires" />
            <option value="UTC" />
          </datalist>
        </label>
      </div>
      <div className="flex flex-col gap-3 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-xs leading-5 text-slate-500">
          Se crea en onboarding y con el workspace bloqueado. Sus roles, módulos y estructura quedan listos para configurar sin exponer datos operacionales.
        </p>
        <SubmitButton>Crear empresa</SubmitButton>
      </div>
      <ActionFeedback state={state} />
    </form>
  );
}

export interface ManagementRoleOption {
  id: string;
  name: string;
}

export function InviteMemberForm({ companyId, roles, canManage }: { companyId: string; roles: ManagementRoleOption[]; canManage: boolean }) {
  const [state, action] = useActionState(inviteCompanyMemberAction, INITIAL_STATE);
  if (!canManage) return null;

  return (
    <form action={action} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <input type="hidden" name="companyId" value={companyId} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(190px,0.45fr)_auto] sm:items-end">
        <label className="text-sm font-medium text-slate-700">
          Correo de la persona
          <input name="email" type="email" required maxLength={254} className={INPUT_CLASS} placeholder="persona@empresa.cl" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Rol inicial
          <select name="roleId" required className={INPUT_CLASS} defaultValue="">
            <option value="" disabled>Seleccionar</option>
            {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
          </select>
        </label>
        <SubmitButton>Enviar invitación</SubmitButton>
      </div>
      <p className="mt-2 text-xs text-slate-500">Si la persona ya tiene cuenta, podrá ingresar directamente. Si es nueva, recibirá un correo para confirmar su acceso.</p>
      <ActionFeedback state={state} />
    </form>
  );
}

export function ResendInvitationForm({ companyId, invitationId }: { companyId: string; invitationId: string }) {
  const [state, action] = useActionState(resendCompanyInvitationAction, INITIAL_STATE);
  return (
    <form action={action} className="mt-2">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="invitationId" value={invitationId} />
      <SubmitButton compact>Reintentar correo</SubmitButton>
      <ActionFeedback state={state} />
    </form>
  );
}

export function MemberRoleForm({
  companyId,
  membershipId,
  selectedRoleId,
  roles,
  canManage,
  membershipActive,
}: {
  companyId: string;
  membershipId: string;
  selectedRoleId: string | null;
  roles: ManagementRoleOption[];
  canManage: boolean;
  membershipActive: boolean;
}) {
  const [state, action] = useActionState(assignCompanyRoleAction, INITIAL_STATE);
  if (!canManage) return <span className="text-xs text-slate-400">Solo lectura</span>;
  if (!membershipActive) return <span className="text-xs text-slate-400">Activa la membresía antes de asignar roles</span>;

  return (
    <form action={action} className="min-w-48">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="membershipId" value={membershipId} />
      <div className="flex items-center gap-2">
        <select name="roleId" required defaultValue={selectedRoleId ?? ""} className="min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800">
          <option value="" disabled>Sin rol</option>
          {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
        </select>
        <SubmitButton compact>Asignar</SubmitButton>
      </div>
      <ActionFeedback state={state} />
    </form>
  );
}

const MODULE_STATUSES: Array<{ value: CompanyModuleStatus; label: string }> = [
  { value: "ENABLED", label: "Habilitado" },
  { value: "PILOT", label: "Piloto" },
  { value: "SETUP_REQUIRED", label: "Configuración pendiente" },
  { value: "DISABLED", label: "Deshabilitado" },
];

export function ModuleStatusForm({ companyId, moduleKey, status, canManage }: { companyId: string; moduleKey: string; status: CompanyModuleStatus; canManage: boolean }) {
  const [state, action] = useActionState(setCompanyModuleStatusAction, INITIAL_STATE);
  if (!canManage) return null;

  return (
    <form action={action} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="moduleKey" value={moduleKey} />
      <select name="status" defaultValue={status} className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-800">
        {MODULE_STATUSES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select>
      <SubmitButton compact>Guardar</SubmitButton>
      <ActionFeedback state={state} />
    </form>
  );
}

export function OnboardingStepForm({ companyId, stepKey, status, canManage, blockedReason }: { companyId: string; stepKey: string; status: CompanyOnboardingStatus; canManage: boolean; blockedReason?: string }) {
  const [state, action] = useActionState(setOnboardingStepStatusAction, INITIAL_STATE);
  if (!canManage) return null;
  if (blockedReason) return <span className="max-w-56 text-right text-xs leading-5 text-amber-700">{blockedReason}</span>;
  const nextStatus = status === "COMPLETE" ? "NOT_STARTED" : "COMPLETE";

  return (
    <form action={action}>
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="stepKey" value={stepKey} />
      <input type="hidden" name="status" value={nextStatus} />
      <SubmitButton compact>{status === "COMPLETE" ? "Reabrir" : "Completar"}</SubmitButton>
      <ActionFeedback state={state} />
    </form>
  );
}

export interface OrganizationParentOption {
  id: string;
  name: string;
  depth: number;
}

const UNIT_KINDS: Array<{ value: OrganizationUnitKind; label: string }> = [
  { value: "DIVISION", label: "División" },
  { value: "AREA", label: "Área" },
  { value: "DEPARTMENT", label: "Departamento" },
  { value: "TEAM", label: "Equipo" },
  { value: "OTHER", label: "Otra unidad" },
];

export function OrganizationUnitForm({ companyId, parents, canManage }: { companyId: string; parents: OrganizationParentOption[]; canManage: boolean }) {
  const [state, action] = useActionState(createOrganizationUnitAction, INITIAL_STATE);
  if (!canManage) return null;

  return (
    <form action={action} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <input type="hidden" name="companyId" value={companyId} />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 xl:items-end">
        <label className="text-sm font-medium text-slate-700">
          Nombre
          <input name="name" required minLength={2} maxLength={120} className={INPUT_CLASS} placeholder="Ej. Finanzas" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Código
          <input name="code" required maxLength={40} pattern="[A-Z0-9][A-Z0-9_-]*" className={INPUT_CLASS} placeholder="FINANZAS" />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Tipo
          <select name="unitType" defaultValue="AREA" className={INPUT_CLASS}>
            {UNIT_KINDS.map((kind) => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Unidad superior
          <select name="parentId" required defaultValue={parents[0]?.id ?? ""} className={INPUT_CLASS}>
            {parents.map((parent) => <option key={parent.id} value={parent.id}>{"—".repeat(parent.depth)} {parent.name}</option>)}
          </select>
        </label>
      </div>
      <div className="mt-4 flex justify-end"><SubmitButton>Agregar unidad</SubmitButton></div>
      <ActionFeedback state={state} />
    </form>
  );
}
