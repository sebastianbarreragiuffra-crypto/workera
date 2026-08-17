-- Fase 2 — 07: seeds estructurales confirmados
--
-- Se siembra únicamente lo que los documentos de negocio confirman como real
-- hoy (docs/BUSINESS_RULES_PRE_PHASE2.md, prompt Fase 2 §43). NO se siembra:
--   * la regla de viernes para Producción (P0 sin confirmar — no se crea
--     overtime_policy para PRODUCTION + viernes/sábado/domingo);
--   * ninguna regla de clasificación HH 50% vs HH 100% (eso es lógica de
--     cálculo futura, no un dato de catálogo);
--   * tolerancia de atraso distinta de 0 (sin confirmación de RRHH).
--
-- day_of_week: 0 = domingo … 6 = sábado (convención documentada en
-- docs/DATA_MODEL_PHASE2.md).

-- ---------------------------------------------------------------------------
-- employee_groups — confirmado explícitamente en todos los documentos de negocio
insert into public.employee_groups (code, name) values
  ('ADMINISTRATION', 'Administración'),
  ('PRODUCTION', 'Producción');

-- ---------------------------------------------------------------------------
-- absence_types — conjunto conceptual confirmado por BUSINESS_RULES_PRE_PHASE2.md
-- y evidenciado por el Excel real. Vocabulario de códigos aún sujeto a
-- confirmación final de negocio (P2) — al ser catálogo, renombrar es una fila,
-- no una migración de esquema.
insert into public.absence_types (code, name) values
  ('VACATION', 'Vacaciones'),
  ('MEDICAL_LEAVE', 'Licencia médica común'),
  ('WORK_ACCIDENT_LEAVE', 'Licencia mutual / accidente del trabajo'),
  ('ABSENCE', 'Falta'),
  ('PERMISSION', 'Permiso'),
  ('DAY_OFF', 'Día libre'),
  ('OTHER', 'Otro');

-- ---------------------------------------------------------------------------
-- overtime_types — confirmado por el Excel real (columnas "HH 50%" / "HH 100%").
-- Solo se confirma que ambas tasas EXISTEN, no la regla que determina cuál aplica.
insert into public.overtime_types (code, name) values
  ('OVERTIME_50', 'Hora extra 50%'),
  ('OVERTIME_100', 'Hora extra 100%');

-- ---------------------------------------------------------------------------
-- work_schedules / work_schedule_rules — horario real conocido (lunes-jueves
-- 07:30-17:00, viernes 07:30-14:50), provisto explícitamente en el encargo.
insert into public.work_schedules (name) values ('Horario estándar planta');

insert into public.work_schedule_rules (work_schedule_id, day_of_week, scheduled_start, scheduled_end)
select ws.id, d.dow, d.start_time, d.end_time
from public.work_schedules ws
cross join (values
  (1, time '07:30', time '17:00'), -- lunes
  (2, time '07:30', time '17:00'), -- martes
  (3, time '07:30', time '17:00'), -- miércoles
  (4, time '07:30', time '17:00'), -- jueves
  (5, time '07:30', time '14:50')  -- viernes
) as d(dow, start_time, end_time)
where ws.name = 'Horario estándar planta';
-- Sábado (6) y domingo (0) quedan sin fila = no laborales en esta jornada.

-- ---------------------------------------------------------------------------
-- late_arrival_policies — tolerancia 0 para todos los grupos y días, hasta que
-- RRHH confirme un valor distinto (docs/BUSINESS_RULES_PRE_PHASE2.md sección 13).
insert into public.late_arrival_policies (employee_group_id, day_of_week, tolerance_minutes, effective_from)
select eg.id, d.dow, 0, date '2026-01-01'
from public.employee_groups eg
cross join generate_series(0, 6) as d(dow);

-- ---------------------------------------------------------------------------
-- overtime_policies
--
-- ADMINISTRATION: sin derecho a horas extra en este proceso, todos los días
-- (confirmado explícitamente — docs/BUSINESS_RULES_PRE_PHASE2.md sección 5).
insert into public.overtime_policies (employee_group_id, day_of_week, overtime_eligible, max_overtime_minutes, effective_from)
select eg.id, d.dow, false, null, date '2026-01-01'
from public.employee_groups eg
cross join generate_series(0, 6) as d(dow)
where eg.code = 'ADMINISTRATION';

-- PRODUCTION: elegible lunes a jueves, tope 120 min (confirmado). Viernes,
-- sábado y domingo se dejan SIN fila a propósito — la regla de viernes es P0
-- sin confirmar (prompt Fase 2 §8/§12); el motor de cálculo futuro debe tratar
-- la ausencia de política como NEEDS_REVIEW, nunca asumir elegible o no elegible.
insert into public.overtime_policies (employee_group_id, day_of_week, overtime_eligible, max_overtime_minutes, effective_from)
select eg.id, d.dow, true, 120, date '2026-01-01'
from public.employee_groups eg
cross join generate_series(1, 4) as d(dow) -- lunes(1) a jueves(4)
where eg.code = 'PRODUCTION';
