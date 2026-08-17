-- Fase 3 — 23: revocación y otorgamiento explícito de privilegios (GRANT/REVOKE)
--
-- Hallazgo de la revisión de seguridad de esta fase (encargo sección 55):
-- TODAS las tablas de Fase 2A/2B tienen, por privilegio por defecto de este
-- proyecto Supabase, `anon` y `authenticated` con TRUNCATE + REFERENCES +
-- TRIGGER concedidos automáticamente al crearse (confirmado con
-- information_schema.role_table_grants). Esto es crítico porque:
--   - TRUNCATE NO está sujeto a Row Level Security (Postgres no filtra
--     TRUNCATE por policy) — un rol con TRUNCATE puede vaciar la tabla
--     completa sin que ninguna policy lo impida.
--   - Sin GRANT explícito de SELECT/INSERT/UPDATE/DELETE, las policies RLS
--     de las migraciones anteriores de Fase 3 NO alcanzan por sí solas: el
--     privilegio a nivel de tabla se evalúa ANTES que RLS, y sin él la
--     operación se rechaza igual, pero confiar en la ausencia accidental de
--     GRANT en vez de una decisión explícita es frágil y no auditable.
--
-- Estrategia: REVOKE ALL de `anon` y `authenticated` sobre cada tabla/vista
-- de negocio, y luego GRANT explícito y mínimo a `authenticated` según
-- exactamente lo que sus policies RLS permiten. anon no recibe ningún GRANT
-- en ninguna tabla (confirma "ANON -> NO BUSINESS DATA", sección 24/30).
--
-- No se modifica ningún privilegio por defecto futuro a nivel de esquema
-- (ALTER DEFAULT PRIVILEGES) — cualquier tabla nueva de una fase futura debe
-- repetir este mismo patrón explícito; documentado como riesgo pendiente en
-- docs/SECURITY_PHASE3.md.

do $$
declare
  t text;
begin
  for t in
    select tablename from pg_tables where schemaname = 'public'
    union
    select viewname from pg_views where schemaname = 'public'
  loop
    execute format('revoke all on table public.%I from anon, authenticated;', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Catálogos: solo lectura.
grant select on public.employee_groups, public.overtime_types, public.absence_types,
  public.attendance_statuses, public.bonus_types
  to authenticated;

-- Tablas de política: lectura amplia + escritura (RLS ya restringe la
-- escritura efectiva a ADMIN_RRHH; el GRANT solo habilita el intento).
grant select, insert, update, delete on public.work_schedules, public.work_schedule_rules,
  public.overtime_policies, public.late_arrival_policies, public.bonus_policies
  to authenticated;

-- profiles: sin INSERT (solo vía trigger SECURITY DEFINER) ni DELETE.
grant select, update on public.profiles to authenticated;

-- employees: lectura amplia, escritura admin (vía RLS).
grant select, insert, update, delete on public.employees to authenticated;

-- Asignaciones organizacionales: lectura amplia, escritura admin (vía RLS).
grant select, insert, update, delete on public.employee_group_assignments,
  public.schedule_assignments, public.supervisor_assignments
  to authenticated;

-- attendance_records: SOLO lectura — ningún GRANT de escritura, ni siquiera
-- para intentarlo (sin policy que lo permitiría de todas formas; se refuerza
-- también al nivel de privilegio, no solo de policy).
grant select on public.attendance_records to authenticated;

-- attendance_corrections: lectura + inserción scoped + actualización admin (is_current).
grant select, insert, update on public.attendance_corrections to authenticated;

-- attendance_status_records: idem.
grant select, insert, update on public.attendance_status_records to authenticated;

-- sync_runs: solo lectura (admin, vía RLS).
grant select on public.sync_runs to authenticated;

-- overtime_records / late_arrival_records: cálculo del sistema, solo lectura.
grant select on public.overtime_records, public.late_arrival_records to authenticated;

-- overtime_decisions / late_arrival_decisions: lectura + inserción scoped +
-- actualización admin.
grant select, insert, update on public.overtime_decisions, public.late_arrival_decisions
  to authenticated;

-- late_arrival_daily_totals: vista, solo lectura.
grant select on public.late_arrival_daily_totals to authenticated;

-- absence_records / absence_decisions: lectura + inserción scoped + actualización admin.
grant select, insert, update on public.absence_records, public.absence_decisions
  to authenticated;

-- employee_daily_bonuses: SOLO lectura (admin, vía RLS) — ningún GRANT de
-- escritura (sección 35: "no permitir crear/editar bonos desde cliente").
grant select on public.employee_daily_bonuses to authenticated;

-- daily_reviews: lectura + actualización scoped (sin INSERT/DELETE).
grant select, update on public.daily_reviews to authenticated;

-- weekly_reviews: lectura + actualización (scoped a estado no
-- CLOSED/REOPENED salvo admin, vía RLS).
grant select, update on public.weekly_reviews to authenticated;

-- weekly_review_snapshots / period_snapshots: lectura + inserción admin (vía RLS).
grant select, insert on public.weekly_review_snapshots, public.period_snapshots
  to authenticated;

-- reporting_periods: lectura + inserción/actualización admin (vía RLS).
grant select, insert, update on public.reporting_periods to authenticated;

-- excel_exports: admin-only (vía RLS) para todo — se otorga el conjunto
-- completo, RLS filtra a quién realmente puede usarlo.
grant select, insert, update, delete on public.excel_exports to authenticated;

-- supporting_documents (tabla base): lectura admin-only, inserción scoped,
-- actualización admin — sin DELETE (sección 15: preferir desactivar).
grant select, insert, update on public.supporting_documents to authenticated;

-- supporting_documents_metadata (vista): ya otorgada explícitamente en su
-- propia migración (22); se reafirma aquí sin duplicar el efecto (GRANT es
-- idempotente).
grant select on public.supporting_documents_metadata to authenticated;

-- audit_log: lectura admin-only + inserción propia (vía RLS) — sin
-- UPDATE/DELETE (además del trigger de inmutabilidad ya agregado).
grant select, insert on public.audit_log to authenticated;

-- ---------------------------------------------------------------------------
-- Verificación de que ningún esquema quedó con una tabla sin RLS habilitado
-- (defensa adicional, falla la migración completa si se detecta una tabla de
-- public sin RLS — cubre la sección 54 del encargo, "RLS coverage audit",
-- como una comprobación automática en vez de solo una revisión manual).
do $$
declare
  missing text;
begin
  select string_agg(c.relname, ', ')
  into missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r' -- solo tablas, las vistas no aplican RLS directamente
    and not c.relrowsecurity;

  if missing is not null then
    raise exception 'Tables without RLS enabled: %', missing;
  end if;
end;
$$;
