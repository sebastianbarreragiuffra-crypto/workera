-- Fase 6A — ingesta controlada de marcaciones reales de Workera.
--
-- Decisión arquitectónica central (encargo Fase 6A, PASO 5): se auditó
-- `public.attendance_records` (Fase 2A) y se confirma que representa un
-- RESUMEN DIARIO — un único par (actual_clock_in, actual_clock_out) por
-- (employee_id, work_date), reforzado por el índice único parcial
-- `attendance_records_current_key on (employee_id, work_date) where
-- is_current`. Workera, en cambio, entrega EVENTOS individuales de
-- marcación (Entrada, Salida, Inicio/Término de descanso, Entrada/Salida
-- extraordinaria) — potencialmente varios por trabajador y día. Forzar esos
-- eventos dentro de `attendance_records` requeriría colapsarlos en un solo
-- clock_in/clock_out, exactamente lo que el encargo prohíbe en esta fase
-- (PASO 4/34: "no colapsar eventos", "ese cálculo pertenece a una fase
-- futura"). Por eso se crea una tabla nueva, `workera_attendance_events`,
-- en vez de forzar el modelo existente — `attendance_records` no se
-- modifica ni se reutiliza para esto.
--
-- `public.employees.external_workera_id` (Fase 2A, ya existente, unique,
-- not null) SÍ se reutiliza tal cual como estrategia de identidad externa —
-- confirmado mediante una llamada real de solo lectura a /attendanceData
-- (Fase 6A, PASO 8): 37/37 eventos con employee.code presente, 36 códigos
-- distintos (la única "duplicación" es un mismo trabajador con 2 eventos el
-- mismo día, exactamente el comportamiento esperado), 0 duplicados de
-- identidad. No se crea ninguna columna nueva en `employees` para esto.
--
-- `public.sync_runs` (Fase 2A) también se reutiliza tal cual — records_read/
-- records_created/records_updated/records_conflicted ya cubren "eventos
-- leídos/insertados/versionados/en conflicto". Solo se agrega
-- `records_unchanged` (no existía un contador para "idéntico al vigente,
-- sin escritura") — extensión aditiva mínima, no una tabla nueva.

alter table public.sync_runs
  add column records_unchanged integer not null default 0;

alter table public.sync_runs
  add constraint sync_runs_unchanged_chk check (records_unchanged >= 0);

comment on column public.sync_runs.records_unchanged is
  'Eventos leídos cuyo fingerprint coincide exactamente con la fila vigente '
  'existente (mismo contenido) — no generan escritura. Fase 6A.';

-- =============================================================================
-- workera_attendance_events — hecho crudo de marcación, a nivel de EVENTO,
-- inmutable salvo is_current (mismo patrón exacto que attendance_records,
-- overtime_records, etc. desde Fase 2A).
-- =============================================================================
create table public.workera_attendance_events (
  id                     uuid primary key default gen_random_uuid(),

  -- Identidad interna resuelta ANTES de insertar (nunca un texto suelto sin
  -- FK) — la resolución employee.code -> employees.external_workera_id
  -- ocurre en el servicio de sync (server-only), nunca en la base. Un
  -- evento cuyo empleado no se resuelve NO se inserta (gate explícito,
  -- PASO 24 del encargo) — por eso NOT NULL sin excepción.
  employee_id            uuid not null references public.employees(id),

  -- Copia del código externo AL MOMENTO de la ingesta (auditoría/debug sin
  -- necesitar join, y estable aunque employees.external_workera_id se
  -- remapeara en el futuro, escenario no contemplado hoy pero no costoso de
  -- preservar).
  external_employee_code text not null,

  -- Fecha calendario derivada de la porción de fecha del timestamp crudo
  -- (los primeros 10 caracteres de un string yyyy-MM-ddTHH:mm:ss) — NO
  -- requiere resolver timezone: es la misma fecha que Workera ya reporta en
  -- el string, sin aritmética.
  work_date              date not null,

  -- Timestamp EXACTO tal como lo entregó Workera, sin modificar — nunca se
  -- pierde, pase lo que pase con la interpretación de zona horaria (Fase 6A,
  -- PASO 13, principio de conservación).
  attendance_timestamp_raw        text not null,

  -- Interpretación best-effort como hora de pared en America/Santiago
  -- (confirmado por evidencia real, Fase 6A PASO 12: GET /timezone del
  -- manual devuelve id=25 "(UTC-04:00) Santiago", zoneDiff=-4, consistente
  -- con la fecha de hoy -invierno chileno-; los timestamps de muestra
  -- también son plausibles como hora local de Santiago). Se calcula vía
  -- trigger usando `AT TIME ZONE 'America/Santiago'` (respeta DST
  -- automáticamente por el tzdata de Postgres — NUNCA un offset fijo -3/-4
  -- hardcodeado, PASO 14 del encargo). NULLABLE y documentada como
  -- interpretación, no como dato autoritativo — attendance_timestamp_raw es
  -- la única fuente de verdad.
  attendance_timestamp_interpreted timestamptz,

  attendance_type_code   smallint not null,
  -- Etiqueta ya normalizada (ENTRADA/SALIDA/... o UNKNOWN_EXTERNAL_TYPE) —
  -- se recibe ya calculada del mapper TypeScript (mismo enum confirmado
  -- desde Fase 5C), no se duplica esa lógica en SQL.
  attendance_type_label   text not null,

  attendance_status              text not null,
  external_attendance_status     text not null,

  origin                  text,
  origin_code             text,
  device_name             text,
  checksum                text,

  -- Fingerprint determinística de idempotencia (Fase 6A, PASO 15/16,
  -- confirmado empíricamente contra datos reales: 37/37 eventos de hoy
  -- produjeron 37 fingerprints distintos, 0 colisiones). Se investigó
  -- `checksum` como candidato a ID único antes de descartarlo como base
  -- principal: el manual lo documenta como "Código Hash asociado al
  -- DISPOSITIVO" (no al evento), y aunque la muestra real de hoy mostró 37
  -- checksums distintos para 37 eventos de un mismo dispositivo, es
  -- evidencia insuficiente (una sola sesión, un solo dispositivo) para
  -- confiar en él como identificador único global y estable en el tiempo —
  -- no se usa como único componente de la fingerprint. GENERATED (no
  -- confiado del cliente/TypeScript): concatenación determinística e
  -- IMMUTABLE de columnas ya persistidas en esta misma fila.
  external_fingerprint    text generated always as (
    'WORKERA|' || external_employee_code || '|' || attendance_timestamp_raw ||
    '|' || attendance_type_code::text || '|' || coalesce(origin_code, '')
  ) stored,

  -- Mismo patrón de versionado que el resto del esquema desde Fase 2A: un
  -- evento reportado como MODIFICADO por Workera no sobrescribe la fila
  -- anterior — la fila anterior queda con is_current=false (historial
  -- preservado) y se inserta una fila nueva con calculation_version+1.
  source_version          integer not null default 1,
  is_current              boolean not null default true,

  sync_run_id             uuid not null references public.sync_runs(id),
  synced_at               timestamptz not null default now(),
  created_at              timestamptz not null default now(),

  constraint workera_attendance_events_type_range_chk
    check (attendance_type_code between 0 and 5),
  constraint workera_attendance_events_version_positive_chk
    check (source_version >= 1),
  constraint workera_attendance_events_fingerprint_version_key
    unique (external_fingerprint, source_version)
);

comment on table public.workera_attendance_events is
  'Hecho crudo de Workera a nivel de EVENTO individual (Entrada/Salida/'
  'Inicio-Término descanso/Entrada-Salida extraordinaria), NUNCA colapsado a '
  'clock_in/clock_out (Fase 6A). Inmutable tras insertar salvo is_current — '
  'mismo patrón que attendance_records desde Fase 2A. NO persiste address, '
  'coordinatesMobile ni precision (minimización de datos, PASO 31 del '
  'encargo Fase 6A) — solo lo necesario para trazabilidad de marcación.';

comment on column public.workera_attendance_events.external_fingerprint is
  'Idempotencia: WORKERA|employee.code|attendanceDate crudo|attendanceType|'
  'originCode. GENERATED (determinística, nunca confiada de TypeScript). '
  'Confirmada con evidencia real: 0 colisiones en 37 eventos reales del día '
  'de la validación (Fase 6A). checksum NO se usa como componente — el '
  'manual lo documenta a nivel de dispositivo, no de evento, y la evidencia '
  'disponible es insuficiente para tratarlo como ID único global.';

-- Idempotencia real, garantizada por la base de datos incluso si hay un bug
-- en la capa de aplicación (PASO 16 del encargo, "no depender solamente de
-- SELECT before INSERT"): a lo sumo una fila VIGENTE por fingerprint.
create unique index workera_attendance_events_fingerprint_current_key
  on public.workera_attendance_events (external_fingerprint)
  where is_current;

create index workera_attendance_events_employee_work_date_idx
  on public.workera_attendance_events (employee_id, work_date);
create index workera_attendance_events_sync_run_id_idx
  on public.workera_attendance_events (sync_run_id);

-- Interpretación de timezone + work_date se calculan en el servidor,
-- respetando DST vía el tzdata de Postgres — nunca confiados de un valor
-- enviado por TypeScript (PASO 14: nunca aritmética manual de offset).
create or replace function public.set_workera_attendance_event_derived_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.work_date := substring(new.attendance_timestamp_raw from 1 for 10)::date;
  new.attendance_timestamp_interpreted :=
    (new.attendance_timestamp_raw::timestamp) at time zone 'America/Santiago';
  return new;
end;
$$;

comment on function public.set_workera_attendance_event_derived_fields() is
  'Calcula work_date y attendance_timestamp_interpreted a partir de '
  'attendance_timestamp_raw. La conversión de zona horaria usa '
  'AT TIME ZONE ''America/Santiago'' (respeta DST automáticamente vía el '
  'tzdata de Postgres) — nunca un offset fijo -3/-4 hardcodeado (Fase 6A, '
  'PASO 14 del encargo).';

create trigger workera_attendance_events_set_derived_fields
  before insert on public.workera_attendance_events
  for each row
  execute function public.set_workera_attendance_event_derived_fields();

-- Inmutabilidad: reutiliza la función genérica ya existente desde Fase 2A
-- (enforce_immutable_columns), sin modificarla — solo is_current puede
-- cambiar tras insertar.
--
-- `external_fingerprint` se agrega también a la lista de columnas
-- "mutables" del trigger, pero NO porque se permita que cambie en la
-- práctica — es una columna GENERATED ALWAYS ... STORED, así que su valor
-- es enteramente derivado de otras columnas (external_employee_code,
-- attendance_timestamp_raw, attendance_type_code, origin_code) que sí
-- siguen protegidas individualmente por este mismo trigger, así que su
-- valor lógico nunca puede divergir entre versiones de una fila. La razón
-- técnica de excluirla es una limitación documentada de PostgreSQL: dentro
-- de un trigger BEFORE, el valor NUEVO de una columna GENERATED STORED
-- todavía no ha sido calculado por el motor (se calcula recién después de
-- que corren los triggers BEFORE ROW) y por lo tanto NO es observable de
-- forma confiable ahí — comparar OLD vs. NEW para esa columna dentro de
-- enforce_immutable_columns produce un falso positivo (columna "cambiada")
-- en CUALQUIER UPDATE, incluso uno que solo toca is_current. Se descubrió
-- este defecto real al ejecutar el flujo completo de versionado (Fase 6A,
-- pgTAP 025): una fila real, real UPDATE de solo is_current, rechazado con
-- "Column external_fingerprint is immutable" pese a que ningún dato de
-- origen cambió. Ver
-- https://www.postgresql.org/docs/current/ddl-generated-columns.html
-- ("it is not possible to directly inspect the value of a generated column
-- in a BEFORE trigger").
create trigger workera_attendance_events_immutable
  before update on public.workera_attendance_events
  for each row
  execute function public.enforce_immutable_columns('is_current', 'external_fingerprint');

-- ---------------------------------------------------------------------------
-- RLS: lectura amplia, CERO policies de escritura para `authenticated` —
-- exactamente el mismo criterio que attendance_records desde Fase 2A/3
-- (Fase 6A PASO 3/27: "ni Supervisor, ni RRHH, ni SUPER_ADMIN pueden
-- sobrescribir una marcación original de Workera"). La única vía de
-- escritura es `service_role` (el servicio de sync, server-only), que
-- bypassea RLS por diseño de Postgres/Supabase.
alter table public.workera_attendance_events enable row level security;

create policy workera_attendance_events_select on public.workera_attendance_events
  for select to authenticated using (public.is_corporate_user());

revoke all on table public.workera_attendance_events from anon, authenticated;
grant select on public.workera_attendance_events to authenticated;

-- ---------------------------------------------------------------------------
-- GRANTS PARA service_role (hallazgo real de Fase 6A, confirmado por
-- ejecución real, no por inspección de código): `service_role` tiene
-- `BYPASSRLS` (correcto, de fábrica) pero NINGUNA migración de este
-- proyecto —desde Fase 2A— le otorgó jamás privilegios de tabla
-- (SELECT/INSERT/UPDATE/DELETE) sobre ninguna tabla de negocio. Cada
-- comentario del esquema ("la única vía de escritura es service_role, que
-- bypassea RLS por diseño") asumía que el bypass de RLS por sí solo bastaba
-- para escribir — en Postgres, BYPASSRLS omite la evaluación de políticas,
-- pero el chequeo de privilegio de tabla (GRANT) sigue aplicando igual que
-- para cualquier rol. Se reprodujo el error real: `permission denied for
-- table employees` al intentar el primer dry-run real de este pipeline.
--
-- Se otorga aquí EXACTAMENTE lo que este pipeline necesita —
-- `employees`/`sync_runs`/`workera_attendance_events`— y no más. El mismo
-- vacío existe en el resto de las ~36 tablas del esquema (confirmado por
-- consulta directa a information_schema.role_table_grants); corregirlo de
-- forma integral para toda futura automatización con service_role
-- (sincronización de employees completos, absences, etc.) queda fuera de
-- alcance de Fase 6A y se documenta como riesgo residual en
-- docs/WORKERA_SYNC_PHASE6A.md.
grant select, insert on public.employees to service_role;
grant select, insert, update on public.sync_runs to service_role;
grant select, insert, update on public.workera_attendance_events to service_role;
