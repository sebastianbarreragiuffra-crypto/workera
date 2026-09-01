-- Feriados legales de Chile 2026-2027 (MB-6).
--
-- Contexto: la tabla `holidays` (Gate D) existe desde el motor de horas extra
-- pero nunca se pobló. Consecuencias reales, ambas con efecto en plata:
--
--   1. `classify_overtime_type_id` YA consulta esta tabla: una hora extra en
--      feriado debe pagarse al 100%, pero con la tabla vacía sale al 50%.
--      Poblar la tabla corrige esto sin tocar una linea de codigo.
--   2. `addBusinessDays` (plazos de documento medico/licencia) cuenta solo
--      lunes-viernes; MB-6 lo conecta a esta tabla en el codigo.
--
-- `on conflict do nothing`: es seguro reejecutar y NUNCA pisa un feriado que
-- RRHH haya cargado o editado a mano (la policy holidays_write_admin lo
-- permite).
--
-- Feriados moviles (Ley 19.668): "San Pedro y San Pablo" (29-jun) y "Encuentro
-- de Dos Mundos" (12-oct) se trasladan al lunes de la misma semana cuando caen
-- martes. En 2026 ambos caen lunes (sin traslado); en 2027 caen martes y se
-- trasladan a 28-jun-2027 y 11-oct-2027 respectivamente.
--
-- Viernes/Sabado Santo calculados por computus: Pascua 2026 = 5-abr,
-- Pascua 2027 = 28-mar.

insert into public.holidays (holiday_date, name) values
  -- 2026
  ('2026-01-01', 'Ano Nuevo'),
  ('2026-04-03', 'Viernes Santo'),
  ('2026-04-04', 'Sabado Santo'),
  ('2026-05-01', 'Dia Nacional del Trabajo'),
  ('2026-05-21', 'Dia de las Glorias Navales'),
  ('2026-06-20', 'Dia Nacional de los Pueblos Indigenas'),
  ('2026-06-29', 'San Pedro y San Pablo'),
  ('2026-07-16', 'Virgen del Carmen'),
  ('2026-08-15', 'Asuncion de la Virgen'),
  ('2026-09-18', 'Independencia Nacional'),
  ('2026-09-19', 'Dia de las Glorias del Ejercito'),
  ('2026-10-12', 'Encuentro de Dos Mundos'),
  ('2026-10-31', 'Dia de las Iglesias Evangelicas y Protestantes'),
  ('2026-11-01', 'Dia de Todos los Santos'),
  ('2026-12-08', 'Inmaculada Concepcion'),
  ('2026-12-25', 'Navidad'),
  -- 2027
  ('2027-01-01', 'Ano Nuevo'),
  ('2027-03-26', 'Viernes Santo'),
  ('2027-03-27', 'Sabado Santo'),
  ('2027-05-01', 'Dia Nacional del Trabajo'),
  ('2027-05-21', 'Dia de las Glorias Navales'),
  -- VERIFICAR contra el decreto oficial: el solsticio de invierno 2027 cae
  -- entre el 20 y 21 de junio segun la hora de Chile. Ajustar si el decreto
  -- publica otra fecha.
  ('2027-06-21', 'Dia Nacional de los Pueblos Indigenas'),
  ('2027-06-28', 'San Pedro y San Pablo (trasladado del 29)'),
  ('2027-07-16', 'Virgen del Carmen'),
  ('2027-08-15', 'Asuncion de la Virgen'),
  ('2027-09-18', 'Independencia Nacional'),
  ('2027-09-19', 'Dia de las Glorias del Ejercito'),
  ('2027-10-11', 'Encuentro de Dos Mundos (trasladado del 12)'),
  ('2027-10-31', 'Dia de las Iglesias Evangelicas y Protestantes'),
  ('2027-11-01', 'Dia de Todos los Santos'),
  ('2027-12-08', 'Inmaculada Concepcion'),
  ('2027-12-25', 'Navidad')
on conflict (holiday_date) do nothing;
