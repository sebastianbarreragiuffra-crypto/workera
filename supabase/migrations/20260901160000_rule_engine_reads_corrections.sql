-- El motor de reglas debe ver la marcación EFECTIVA, no solo la cruda (MB-3).
--
-- Situación encontrada: Gate D dejó el modelo correcto -- `attendance_records`
-- guarda el dato crudo de Workera (inmutable), `attendance_corrections` guarda
-- la corrección autorizada, y la vista `attendance_effective_punches` expone
-- el COALESCE de ambos. A nivel de base, la aprobación de horas extra YA se
-- valida contra el dato efectivo (`enforce_overtime_decision_validations`) y
-- una corrección resuelve sola la bandera de marcación faltante.
--
-- Pero los generadores de candidatos de Fase 7 reciben el clock_in/clock_out
-- CRUDO. Consecuencia real: si un trabajador olvida marcar la salida, el jefe
-- corrige la marcación y la bandera se resuelve, pero el candidato de horas
-- extra nunca llega a generarse porque el motor sigue viendo `NULL`. El
-- orquestador (MB-2) pasa a leer la vista para cerrar ese hueco.
--
-- La vista es `security_invoker=true`, así que leerla como `service_role`
-- exige grant sobre la vista Y sobre las tablas subyacentes. `service_role` ya
-- tiene SELECT en `attendance_records`; falta `attendance_corrections`.
--
-- Solo SELECT: el motor jamás escribe una corrección. Esa sigue siendo una
-- acción humana, hecha con la sesión del supervisor y sujeta a la RLS
-- `attendance_corrections_insert` (corrected_by = auth.uid() AND
-- can_manage_employee(employee_id)).

grant select on public.attendance_corrections to service_role;
grant select on public.attendance_effective_punches to service_role;

comment on view public.attendance_effective_punches is
  'Marcación cruda vs. efectiva (cruda + corrección vigente). Fuente única de '
  'verdad de "qué hora vale" para el motor de reglas y para la validación de '
  'aprobación de horas extra -- ningún consumidor debe recalcular ese COALESCE '
  'por su cuenta.';
