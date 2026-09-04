-- Cierre de hallazgos de seguridad del primer rollout MFA.
--
-- Esta migración es posterior a la fundación y al refuerzo AAL2 para que sea
-- segura incluso si esas dos migraciones ya alcanzaron un ambiente remoto.

-- Una membresía de plataforma activa no vuelve privilegiado a un profile
-- desactivado. Ambas fuentes deben seguir activas para exigir o conceder MFA.
create or replace function public.account_requires_mfa(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.profiles p
      where p.id = p_user
        and p.active
        and p.role in ('SUPER_ADMIN', 'ADMIN_RRHH')
    )
    or exists (
      select 1
      from public.platform_memberships pm
      join public.profiles p on p.id = pm.user_id and p.active
      where pm.user_id = p_user
        and pm.active
        and pm.role in ('OWNER', 'ADMIN')
    );
$$;

-- El MFA pertenece a la identidad global de Auth, no a una empresa. Un
-- administrador tenant no puede borrar factores globales sin afectar las
-- demás empresas de una identidad multi-tenant. Por eso el reseteo queda en
-- manos del OWNER del control plane; la propia cuenta OWNER sigue excluida y
-- usa el procedimiento break-glass documentado.
create or replace function public.can_reset_mfa_for(p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    p_target is not null
    and p_target <> auth.uid()
    and exists (
      select 1
      from public.profiles actor
      join public.platform_memberships pm
        on pm.user_id = actor.id
       and pm.active
       and pm.role = 'OWNER'
      where actor.id = auth.uid()
        and actor.active
    )
    and not exists (
      select 1
      from public.platform_memberships target_pm
      where target_pm.user_id = p_target
        and target_pm.active
        and target_pm.role = 'OWNER'
    ),
    false
  );
$$;

-- Leer la bitácora también exige que el profile del actor siga activo. El
-- acceso de lectura empresarial se conserva porque no modifica la identidad;
-- el reseteo global, en cambio, quedó restringido arriba al OWNER.
create or replace function public.can_read_mfa_events_for(p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from public.profiles actor
      where actor.id = auth.uid()
        and actor.active
    )
    and (
      p_target = auth.uid()
      or exists (
        select 1
        from public.platform_memberships pm
        where pm.user_id = auth.uid()
          and pm.active
          and pm.role = 'OWNER'
      )
      or exists (
        select 1
        from public.company_memberships me
        join public.company_memberships target
          on target.company_id = me.company_id
         and target.active
        where me.user_id = auth.uid()
          and me.active
          and me.role in ('SUPER_ADMIN', 'ADMIN_RRHH')
          and target.user_id = p_target
      )
    ),
    false
  );
$$;

-- Un reseteo puede fallar entre dos llamadas a la API de Auth. La bitácora
-- registra el comienzo antes de borrar el primer factor y luego el resultado,
-- por lo que una operación parcial nunca queda sin rastro.
alter table public.mfa_events
  drop constraint mfa_events_event_type_check,
  drop constraint mfa_events_performed_by_chk;

alter table public.mfa_events
  add constraint mfa_events_event_type_check check (
    event_type in (
      'ENROLLED', 'VERIFY_SUCCESS', 'VERIFY_FAILURE', 'UNENROLLED',
      'ADMIN_RESET_STARTED', 'ADMIN_RESET', 'ADMIN_RESET_PARTIAL',
      'ADMIN_RESET_FAILED'
    )
  ),
  add constraint mfa_events_performed_by_chk check (
    (
      event_type in (
        'ADMIN_RESET_STARTED', 'ADMIN_RESET', 'ADMIN_RESET_PARTIAL',
        'ADMIN_RESET_FAILED'
      )
      and performed_by is not null
    )
    or (
      event_type not in (
        'ADMIN_RESET_STARTED', 'ADMIN_RESET', 'ADMIN_RESET_PARTIAL',
        'ADMIN_RESET_FAILED'
      )
      and performed_by is null
    )
  );

-- Los eventos son evidencia de seguridad, no datos que el navegador pueda
-- declarar. Solo el backend server-only con service_role los inserta.
drop policy if exists mfa_events_insert on public.mfa_events;
revoke insert on table public.mfa_events from authenticated;
grant insert on table public.mfa_events to service_role;
