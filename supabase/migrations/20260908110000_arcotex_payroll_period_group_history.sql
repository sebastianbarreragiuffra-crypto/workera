-- La planilla operacional de asistencia/pago 2026-08-16..2026-09-15 fue
-- conciliada fuera de la base: contiene 97 identidades distintas y todas
-- corresponden uno-a-uno a los 97 empleados ARCOTEX source=workera activos.
-- El único activo adicional es local_provisional y no aparece en esa fuente.
--
-- La historia de grupo de esas identidades se creó al importar el roster
-- actual, después del período observado. Sin esta evidencia temporal, el
-- motor intenta tratar el padrón actual como si fuera histórico y falla
-- cerrado al reconciliar candidatos. Este helper privado sólo puede extender
-- una asignación inicial única, interna y todavía alineada con el grupo actual;
-- nunca pisa una historia real, una fecha de ingreso posterior ni otra empresa.

create or replace function private.extend_arcotex_initial_group_from_roster_period(
  p_employee_id uuid,
  p_period_start date
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_assignment_id uuid;
begin
  if p_employee_id is null or p_period_start is null then
    return false;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_employee_id::text || '|initial-group-history', 11)
  );

  select ega.id
    into v_assignment_id
  from public.employee_group_assignments ega
  join public.employees e
    on e.id = ega.employee_id
   and e.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
   and e.source = 'workera'
   and e.active
   and (e.hire_date is null or e.hire_date <= p_period_start)
   and e.employee_group_id = ega.employee_group_id
  where ega.employee_id = p_employee_id
    and ega.source = 'internal'
    and ega.sync_run_id is null
    and p_period_start < ega.effective_from
    and (
      select pg_catalog.count(*)
      from public.employee_group_assignments history
      where history.employee_id = p_employee_id
    ) = 1
  for update of ega;

  if v_assignment_id is null then
    return false;
  end if;

  update public.employee_group_assignments
  set effective_from = p_period_start
  where id = v_assignment_id;
  return true;
end;
$$;

comment on function private.extend_arcotex_initial_group_from_roster_period(uuid, date) is
  'Extiende una asignación inicial ARCOTEX source=workera cuando existe evidencia operacional externa del período; no modifica historias múltiples, otros tenants ni fuentes provisionales.';

revoke all on function private.extend_arcotex_initial_group_from_roster_period(uuid, date)
  from public, anon, authenticated, service_role;

do $extend_arcotex_payroll_period_group_history$
declare
  employee record;
begin
  for employee in
    select e.id
    from public.employees e
    where e.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
      and e.source = 'workera'
      and e.active
      and (e.hire_date is null or e.hire_date <= date '2026-08-16')
  loop
    perform private.extend_arcotex_initial_group_from_roster_period(
      employee.id,
      date '2026-08-16'
    );
  end loop;
end;
$extend_arcotex_payroll_period_group_history$;

do $assert_arcotex_payroll_period_group_history$
begin
  if exists (
    select 1
    from public.employees e
    where e.company_id = '0a4c0000-0000-0000-0000-000000000001'::uuid
      and e.source = 'workera'
      and e.active
      and (e.hire_date is null or e.hire_date <= date '2026-08-16')
      and not exists (
        select 1
        from public.employee_group_assignments ega
        join public.employee_groups eg
          on eg.id = ega.employee_group_id
         and eg.company_id = e.company_id
        where ega.employee_id = e.id
          and date '2026-08-16'
              between ega.effective_from and coalesce(ega.effective_to, 'infinity'::date)
      )
  ) then
    raise exception 'La evidencia de asistencia/pago no pudo cubrir el grupo histórico de todo el roster Workera ARCOTEX.'
      using errcode = '23514';
  end if;
end;
$assert_arcotex_payroll_period_group_history$;
