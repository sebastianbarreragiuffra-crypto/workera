-- MFA (TOTP) para cuentas privilegiadas -- fundación en base de datos.
-- Etapa A de la sección 9 de docs/MFA_DESIGN.md, que es la fuente única de
-- verdad de esta funcionalidad.
--
-- Esta migración es deliberadamente INERTE en producción: crea la bitácora de
-- eventos, la regla de qué cuentas exigen segundo factor y las guardas
-- reutilizables, pero por sí sola no bloquea a nadie. El bloqueo real llega
-- con `MFA_ENFORCEMENT_ENABLED` en el middleware (etapa E) y con
-- `enforce_mfa_for_privileged()` aplicado a RPC concretos (etapa F).

-- ---------------------------------------------------------------------------
-- Bitácora append-only de eventos de segundo factor.
--
-- `user_id` y `performed_by` referencian `public.profiles(id)` y no
-- `auth.users(id)`: es la convención vigente del repositorio y su razón está
-- documentada en 20260817152004_auth_roles_and_helpers.sql -- los fixtures de
-- prueba crean profiles sin fila real en auth.users. Para toda cuenta real el
-- trigger `handle_new_auth_user` garantiza `profiles.id = auth.users.id`, así
-- que la semántica es la misma sin romper las pruebas.
--
-- `factor_id` es texto y no uuid porque es un identificador que emite Supabase
-- Auth: se guarda como referencia opaca, nunca se usa para unir tablas.
create table public.mfa_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id),
  event_type   text not null check (event_type in
                 ('ENROLLED', 'VERIFY_SUCCESS', 'VERIFY_FAILURE', 'UNENROLLED', 'ADMIN_RESET')),
  performed_by uuid references public.profiles(id),
  factor_id    text check (factor_id is null or char_length(factor_id) <= 100),
  created_at   timestamptz not null default now(),
  -- `performed_by` existe solo para el reseteo hecho por otra persona. En
  -- todo evento propio queda nulo, así que la bitácora nunca deja dudas sobre
  -- si el segundo factor lo movió su dueño o un administrador.
  constraint mfa_events_performed_by_chk check (
    (event_type = 'ADMIN_RESET' and performed_by is not null)
    or (event_type <> 'ADMIN_RESET' and performed_by is null)
  )
);

create index mfa_events_user_idx on public.mfa_events (user_id, created_at desc);

comment on table public.mfa_events is
  'Bitácora append-only de inscripción, verificación y reseteo de segundo '
  'factor. Nunca guarda secretos TOTP ni códigos: solo el tipo de evento, a '
  'quién corresponde y el identificador opaco del factor.';

alter table public.mfa_events enable row level security;

-- ---------------------------------------------------------------------------
-- Regla única de qué cuentas exigen MFA.
--
-- La necesidad se DERIVA del rol; no se guarda en `profiles`. Una columna
-- `requires_mfa` se desincronizaría el día que alguien cambia de rol. Hoy el
-- conjunto es: privilegiados del workspace (SUPER_ADMIN / ADMIN_RRHH) y
-- administradores de la plataforma (OWNER / ADMIN). Extender el alcance a
-- futuro es editar SOLO esta función.
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
      where pm.user_id = p_user
        and pm.active
        and pm.role in ('OWNER', 'ADMIN')
    );
$$;

comment on function public.account_requires_mfa(uuid) is
  'Único lugar donde vive la regla de qué cuentas exigen segundo factor. '
  'Interna: no se concede EXECUTE a authenticated para no permitir sondear '
  'qué identificadores corresponden a cuentas privilegiadas.';

-- El request actual llegó con segundo factor verificado.
--
-- En producción el nivel viaja en el JWT y lo entrega `auth.jwt()`. La lectura
-- de `request.jwt.claim.aal` es el mismo patrón de doble origen que usa
-- `auth.uid()` de Supabase: cubre el GUC individual que PostgREST también
-- expone y es la forma en que las pruebas fijan el nivel. Ningún cliente puede
-- fijar estos parámetros por su cuenta -- los escribe PostgREST a partir del
-- JWT ya verificado.
create or replace function public.request_is_aal2()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    auth.jwt() ->> 'aal',
    nullif(current_setting('request.jwt.claim.aal', true), ''),
    'aal1'
  ) = 'aal2';
$$;

-- Guarda para RPC sensibles. Si tu rol exige MFA, tenés que venir en aal2.
-- Si tu rol NO exige MFA, pasás igual -- por eso es seguro agregarla a
-- cualquier RPC sin cambiar el comportamiento de quien está fuera del
-- conjunto MFA.
--
-- SECURITY DEFINER por plumbing de privilegios, no por autorización: necesita
-- llamar a `account_requires_mfa`, que es interna. La identidad y el nivel del
-- request los siguen dando `auth.uid()` y `auth.jwt()`, que leen parámetros de
-- la sesión y no cambian con el dueño de la función.
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

-- ¿El usuario actual puede resetear el segundo factor de `p_target`?
--   Nivel 1: OWNER de plataforma -> a cualquiera, en cualquier empresa.
--   Nivel 2: admin de una empresa -> solo a otro miembro de esa misma empresa.
-- Nadie se resetea a sí mismo, y la cuenta OWNER de plataforma no se resetea
-- desde la aplicación en ningún nivel: su recuperación es el break-glass
-- documentado en docs/PLATFORM_OWNER_RUNBOOK.md. Eso último vale incluso si un
-- admin de empresa comparte `company_memberships` con el OWNER.
create or replace function public.can_reset_mfa_for(p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_target is not null
    and p_target <> auth.uid()
    and not exists (
      select 1
      from public.platform_memberships pm
      where pm.user_id = p_target
        and pm.active
        and pm.role = 'OWNER'
    )
    and (
      exists (
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
          on target.company_id = me.company_id and target.active
        where me.user_id = auth.uid()
          and me.active
          and me.role in ('SUPER_ADMIN', 'ADMIN_RRHH')
          and target.user_id = p_target
      )
    );
$$;

-- Quién puede leer los eventos de `p_target`: su dueño, el OWNER de
-- plataforma, y un admin de la misma empresa. Existe como función y no como
-- subconsulta dentro de la policy para no encadenar RLS de
-- `platform_memberships` y `company_memberships` en cada fila leída.
create or replace function public.can_read_mfa_events_for(p_target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
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
        on target.company_id = me.company_id and target.active
      where me.user_id = auth.uid()
        and me.active
        and me.role in ('SUPER_ADMIN', 'ADMIN_RRHH')
        and target.user_id = p_target
    );
$$;

-- Lo que consulta el middleware en el camino aal1: una sola pregunta indexada
-- sobre la propia sesión, sin exponer la regla para terceros.
create or replace function public.session_requires_mfa()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.account_requires_mfa(auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- RLS de la bitácora.

create policy mfa_events_select on public.mfa_events
  for select to authenticated
  using (public.can_read_mfa_events_for(user_id));

-- Cada quien registra sus propios eventos. El único evento que puede registrar
-- una tercera persona es ADMIN_RESET, y solo sobre alguien a quien de verdad
-- puede resetear: la misma regla que autoriza la acción autoriza su registro.
create policy mfa_events_insert on public.mfa_events
  for insert to authenticated
  with check (
    (event_type <> 'ADMIN_RESET' and user_id = auth.uid())
    or (
      event_type = 'ADMIN_RESET'
      and performed_by = auth.uid()
      and public.can_reset_mfa_for(user_id)
    )
  );

-- Append-only de verdad: sin policy de UPDATE/DELETE, y además un trigger que
-- corta la mutación incluso para `postgres` y `service_role`, que no pasan por
-- RLS. Una bitácora de seguridad que su propio administrador puede editar no
-- prueba nada.
create or replace function public.prevent_mfa_events_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'mfa_events es append-only.' using errcode = '55000';
end;
$$;

create trigger mfa_events_immutable
  before update or delete or truncate on public.mfa_events
  for each statement execute function public.prevent_mfa_events_mutation();

-- ---------------------------------------------------------------------------
-- Privilegios mínimos. Desde 20260901124000 las tablas y funciones nuevas no
-- heredan permisos, así que todo lo que sigue es explícito.

revoke all on table public.mfa_events from public, anon, authenticated, service_role;
grant select, insert on table public.mfa_events to authenticated;

-- El lockdown de privilegios por defecto NO retira el EXECUTE que PostgreSQL
-- concede a PUBLIC sobre toda función nueva: `alter default privileges` no
-- alcanza a ese grant implícito. Por eso cada función interna del repositorio
-- lleva su revoke explícito (mismo patrón que `handle_new_auth_user` y
-- `sync_arcotex_company_membership`). Sin esto, `account_requires_mfa` quedaría
-- disponible para cualquier sesión, incluida `anon`.
revoke all on function
  public.prevent_mfa_events_mutation(),
  public.account_requires_mfa(uuid),
  public.request_is_aal2(),
  public.enforce_mfa_for_privileged(),
  public.can_reset_mfa_for(uuid),
  public.can_read_mfa_events_for(uuid),
  public.session_requires_mfa()
from public, anon, authenticated;

-- `account_requires_mfa` queda deliberadamente fuera de este grant: es interna
-- y sus dos llamadores legítimos son SECURITY DEFINER.
grant execute on function
  public.request_is_aal2(),
  public.enforce_mfa_for_privileged(),
  public.can_reset_mfa_for(uuid),
  public.can_read_mfa_events_for(uuid),
  public.session_requires_mfa()
to authenticated;
