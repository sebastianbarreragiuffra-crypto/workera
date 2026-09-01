-- El motor de reglas escribe el código diario de asistencia (MB-4).
--
-- Situación encontrada: `attendance_status_records` es la fuente del Excel de
-- asistencia, pero NADIE la escribía salvo `approve_medical_license` (que pone
-- 'L'). Resultado: el export bajaba "?" para todos los trabajadores y todos
-- los días, y no había nada que comparar contra la planilla real de RRHH.
--
-- A partir de MB-4 el orquestador marca automáticamente:
--   P -> hubo marcación de entrada ese día
--   ? -> era día laboral según el horario vigente y no hubo ninguna marcación
--
-- Nunca marca F: convertir la ausencia de una marcación en una falta es una
-- decisión de persona, no de sistema. "?" es literalmente el código que el
-- catálogo ya define para "TARJETA NO MARCADA O CON PROBLEMAS" y es la señal
-- que el jefe de área revisa para ingresar la marcación real (MB-3) o
-- reclasificar el día (F, F-J, F-P, V, L...).
--
-- Solo SELECT sobre el catálogo: los códigos son datos maestros y el motor no
-- tiene por qué poder inventarse uno nuevo.

grant select on public.attendance_statuses to service_role;
grant select, insert, update on public.attendance_status_records to service_role;

comment on table public.attendance_status_records is
  'Código diario de asistencia por trabajador. `source` distingue quién lo '
  'puso: "system" = el motor de reglas (P/?), "manual" = una persona, '
  '"workera" = la fuente externa. El motor NUNCA sobrescribe una fila que no '
  'sea suya: un código ingresado por RRHH sobrevive a cualquier reproceso.';
