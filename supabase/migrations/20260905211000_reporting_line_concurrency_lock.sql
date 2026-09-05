-- Serializa las mutaciones del organigrama por empresa antes de comprobar
-- ciclos. Sin este lock, dos transacciones podían validar cadenas parciales al
-- mismo tiempo y confirmar juntas un ciclo que ninguna alcanzó a observar.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.reporting_line_company_locks (
  company_id uuid primary key
    references public.companies(id) on delete cascade,
  revision bigint not null default 0
);

alter table private.reporting_line_company_locks enable row level security;
revoke all on table private.reporting_line_company_locks
  from public, anon, authenticated, service_role;

comment on table private.reporting_line_company_locks is
  'Fila interna de serialización por empresa para validar el organigrama con una vista vigente.';

create or replace function public.prevent_reporting_line_cycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_period daterange := pg_catalog.daterange(
    new.effective_from,
    new.effective_to,
    '[]'
  );
  v_first_company_id uuid;
  v_second_company_id uuid;
begin
  -- El lock se toma para toda mutación, incluso si la fila queda secundaria.
  -- Así un UPDATE posterior que la convierta en principal participa del mismo
  -- protocolo de serialización y no deja una ruta alternativa sin protección.
  if tg_op = 'UPDATE'
     and old.company_id is distinct from new.company_id then
    -- Dos empresas se bloquean siempre por UUID ascendente. Esto evita que dos
    -- movimientos cruzados A->B y B->A puedan quedar esperando en ciclo.
    if old.company_id < new.company_id then
      v_first_company_id := old.company_id;
      v_second_company_id := new.company_id;
    else
      v_first_company_id := new.company_id;
      v_second_company_id := old.company_id;
    end if;
  else
    v_first_company_id := new.company_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('gestora:reporting-lines'),
    pg_catalog.hashtext(v_first_company_id::text)
  );

  -- El advisory lock ordena las transacciones, pero en REPEATABLE READ la
  -- segunda conservaría un snapshot anterior. Este UPSERT fuerza un conflicto
  -- de escritura sobre la fila de la empresa: READ COMMITTED toma una vista
  -- fresca para el CTE siguiente y REPEATABLE READ/SERIALIZABLE abortan la
  -- transacción tardía con 40001 en vez de aceptar un ciclo.
  insert into private.reporting_line_company_locks as company_lock (
    company_id, revision
  ) values (
    v_first_company_id, 1
  )
  on conflict (company_id) do update
    set revision = company_lock.revision + 1;

  if v_second_company_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('gestora:reporting-lines'),
      pg_catalog.hashtext(v_second_company_id::text)
    );

    insert into private.reporting_line_company_locks as company_lock (
      company_id, revision
    ) values (
      v_second_company_id, 1
    )
    on conflict (company_id) do update
      set revision = company_lock.revision + 1;
  end if;

  if not new.is_primary then
    return new;
  end if;

  if exists (
    with recursive manager_chain(manager_id, common_period, visited) as (
      select
        new.manager_employee_id,
        v_new_period,
        array[new.employee_id, new.manager_employee_id]::uuid[]
      union all
      select
        rl.manager_employee_id,
        chain.common_period * pg_catalog.daterange(
          rl.effective_from,
          rl.effective_to,
          '[]'
        ),
        chain.visited || rl.manager_employee_id
      from manager_chain chain
      join public.reporting_lines rl
        on rl.company_id = new.company_id
       and rl.employee_id = chain.manager_id
       and rl.is_primary
       and rl.id <> new.id
      where pg_catalog.daterange(rl.effective_from, rl.effective_to, '[]')
              && chain.common_period
        and (
          rl.manager_employee_id = new.employee_id
          or not (rl.manager_employee_id = any(chain.visited))
        )
    )
    select 1
    from manager_chain
    where manager_id = new.employee_id
  ) then
    raise exception 'La línea de reporte formaría un ciclo en el organigrama.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.prevent_reporting_line_cycle() is
  'Serializa cambios por empresa con advisory lock más fila de conflicto MVCC y rechaza ciclos de jefatura principal durante una vigencia común.';

revoke all on function public.prevent_reporting_line_cycle()
  from public, anon, authenticated;
