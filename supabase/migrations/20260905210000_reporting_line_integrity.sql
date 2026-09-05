-- Integridad temporal del organigrama multiempresa. Una persona puede tener
-- líneas secundarias simultáneas, pero solo una jefatura principal por fecha y
-- nunca puede formarse un ciclo de dependencia durante una vigencia común.

alter table public.reporting_lines
  add constraint reporting_lines_primary_no_overlap
  exclude using gist (
    company_id with =,
    employee_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  ) where (is_primary);

create or replace function public.prevent_reporting_line_cycle()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_new_period daterange := pg_catalog.daterange(
    new.effective_from,
    new.effective_to,
    '[]'
  );
begin
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

create trigger reporting_lines_prevent_cycle
  before insert or update of company_id, employee_id, manager_employee_id,
    effective_from, effective_to, is_primary
  on public.reporting_lines
  for each row execute function public.prevent_reporting_line_cycle();

comment on constraint reporting_lines_primary_no_overlap on public.reporting_lines is
  'Una persona tiene como máximo una jefatura principal vigente por fecha dentro de su empresa.';
comment on function public.prevent_reporting_line_cycle() is
  'Impide ciclos de jefatura principal cuando todas las aristas comparten al menos una fecha vigente.';

revoke all on function public.prevent_reporting_line_cycle()
  from public, anon, authenticated;
