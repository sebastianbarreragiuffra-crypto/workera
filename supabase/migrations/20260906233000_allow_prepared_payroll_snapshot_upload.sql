-- Permite la única escritura legítima entre prepare y commit del cierre:
-- crear por primera vez el snapshot en la ruta reservada. La versión anterior
-- del guard trataba la reserva PREPARED como evidencia ya registrada y
-- bloqueaba la propia subida que exige el protocolo prepare -> upload -> commit.

create or replace function private.prevent_registered_workforce_object_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_bucket text;
  v_old_name text;
  v_new_bucket text;
  v_new_name text;
begin
  if tg_op <> 'INSERT' then
    v_old_bucket := old.bucket_id;
    v_old_name := old.name;
  end if;
  if tg_op <> 'DELETE' then
    v_new_bucket := new.bucket_id;
    v_new_name := new.name;
  end if;
  if coalesce(v_old_bucket, '') not in ('supporting-documents', 'payroll-workbooks')
     and coalesce(v_new_bucket, '') not in ('supporting-documents', 'payroll-workbooks') then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  -- Serializa la mutación física con aceptación, cierre y fences de fuentes.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('payroll-source-mutation-v1', 0)
  );

  if (
    v_old_bucket = 'supporting-documents'
    and exists (
      select 1
      from public.supporting_documents d
      where d.storage_path = v_old_name
    )
  ) or (
    v_old_bucket = 'payroll-workbooks'
    and (
      exists (
        select 1
        from public.payroll_workbook_versions v
        where v.storage_path = v_old_name
      )
      or exists (
        select 1
        from public.payroll_working_versions w
        where w.storage_path = v_old_name
      )
      or exists (
        select 1
        from private.payroll_period_close_operations o
        where o.storage_path = v_old_name
          and o.status = 'PREPARED'
          and o.expires_at > pg_catalog.statement_timestamp()
      )
    )
  ) then
    raise exception 'No se puede alterar evidencia laboral registrada.'
      using errcode = '42501';
  end if;

  -- Una versión ya registrada nunca se puede recrear ni sobrescribir. Para
  -- una operación PREPARED se permite exclusivamente el INSERT inicial del
  -- actor que reservó la ruta. Storage completa tamaño/metadatos durante esa
  -- escritura; commit_payroll_period_close los valida después junto con el
  -- hash recalculado. UPDATE sigue prohibido, por lo que tampoco se puede usar
  -- upsert para sustituir bytes.
  if tg_op in ('INSERT', 'UPDATE') and (
    (
      v_new_bucket = 'supporting-documents'
      and exists (
        select 1
        from public.supporting_documents d
        where d.storage_path = v_new_name
      )
    )
    or (
      v_new_bucket = 'payroll-workbooks'
      and (
        exists (
          select 1
          from public.payroll_workbook_versions v
          where v.storage_path = v_new_name
        )
        or exists (
          select 1
          from public.payroll_working_versions w
          where w.storage_path = v_new_name
        )
        or exists (
          select 1
          from private.payroll_period_close_operations o
          where o.storage_path = v_new_name
            and o.status = 'PREPARED'
            and o.expires_at > pg_catalog.statement_timestamp()
            and (
              tg_op <> 'INSERT'
              or new.owner_id is distinct from o.actor_id::text
            )
        )
      )
    )
  ) then
    raise exception 'No se puede mover un objeto sobre evidencia laboral registrada.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function private.prevent_registered_workforce_object_mutation() is
  'Serializa evidencia laboral; permite solo el INSERT inicial del actor y ruta de una reserva PREPARED. El commit valida hash, tamaño y metadatos y el guard bloquea toda sustitución posterior.';
