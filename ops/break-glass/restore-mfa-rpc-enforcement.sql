-- RESTAURACIÓN MANUAL posterior al break-glass de MFA.
-- Restablece exactamente la exigencia AAL2 definida por la fundación MFA.

begin;

create or replace function public.enforce_mfa_for_privileged()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.account_requires_mfa(auth.uid()) and not public.request_is_aal2() then
    raise exception 'Esta operación requiere verificación de segundo factor (MFA).'
      using errcode = 'P0001';
  end if;
end;
$$;

commit;
