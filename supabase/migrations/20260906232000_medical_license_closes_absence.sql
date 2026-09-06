-- Una licencia médica aprobada debe cerrar también la ausencia operacional.
--
-- `approve_medical_license` ya proyecta el código L en
-- attendance_status_records para cada día confirmado. Sin embargo, el
-- absence_record vinculado quedaba sin una absence_decision vigente. La cola
-- diaria interpreta exactamente ese estado como una ausencia pendiente, por
-- lo que el mismo caso podía quedar simultáneamente aprobado en Licencias y
-- pendiente en Asistencia.
--
-- Se resuelve mediante un trigger de dominio separado para no duplicar ni
-- debilitar el RPC de aprobación, que además concentra MFA, tenant, locks,
-- límites de rango y la proyección versionada de L. El trigger corre dentro de
-- la MISMA transacción: si cerrar la ausencia falla, también se revierten la
-- aprobación y todos los códigos L.

create or replace function private.close_absence_after_medical_license_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is not distinct from new.status
     or new.status <> 'APPROVED' then
    return new;
  end if;

  -- El trigger canónico `absence_decisions_prepare_rrhh_replacement` bloquea
  -- y versiona cualquier decisión vigente. Reutilizarlo mantiene una sola
  -- vía para el historial y conserva su validación de autoridad de RR. HH.
  insert into public.absence_decisions (
    absence_record_id,
    decision_status,
    reason,
    decided_by,
    decided_at,
    document_required,
    document_deadline
  ) values (
    new.absence_record_id,
    'CONFIRMED',
    'Licencia médica aprobada por RRHH',
    new.approved_by,
    new.approved_at,
    false,
    null
  );

  return new;
end;
$$;

comment on function private.close_absence_after_medical_license_approval() is
  'Al aprobar una licencia médica reemplaza la decisión vigente de la ausencia '
  'por CONFIRMED. Se ejecuta en la misma transacción que genera los códigos L, '
  'de modo que Licencias y la cola diaria nunca divergen.';

revoke all on function private.close_absence_after_medical_license_approval()
  from public, anon, authenticated, service_role;

drop trigger if exists medical_license_approval_closes_absence
  on public.medical_license_approvals;
create trigger medical_license_approval_closes_absence
  after update of status on public.medical_license_approvals
  for each row
  when (old.status is distinct from new.status and new.status = 'APPROVED')
  execute function private.close_absence_after_medical_license_approval();
