-- BREAK-GLASS MANUAL. NO ejecutar como migración ni durante operación normal.
--
-- Uso: solo durante un incidente MFA confirmado, después de desactivar
-- MFA_ENFORCEMENT_ENABLED en la aplicación y registrar el incidente.
-- Conserva las validaciones de rol de cada RPC; desactiva temporalmente solo
-- la exigencia AAL2 compartida.

begin;

create or replace function public.enforce_mfa_for_privileged()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return;
end;
$$;

commit;
