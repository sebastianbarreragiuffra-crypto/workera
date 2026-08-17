-- Fase 2B — 10: justificación estructurada de atrasos + acumulados
--
-- Extiende late_arrival_decisions (Fase 2A) de forma ADITIVA (ALTER TABLE),
-- sin tocar la migración original ni las columnas existentes (justified,
-- payroll_minutes, payroll_effect, reason siguen intactas y en uso).

-- ---------------------------------------------------------------------------
-- justification_status: JUSTIFIED / NOT_JUSTIFIED / PENDING (sección 18)
--
-- Decisión de diseño: en vez de agregar una columna independiente que podría
-- desincronizarse de `justified` (dos fuentes de verdad para la misma
-- decisión), se agrega como COLUMNA GENERADA a partir de `justified`. Esto:
--   - satisface "debe ser estructurado y no inferido de texto" (se deriva de
--     un booleano tipado, nunca de parsear `reason`);
--   - es imposible que quede inconsistente con `justified` (Postgres la
--     recalcula siempre, no se puede escribir directamente);
--   - no requiere modificar ningún INSERT existente de Fase 2A — las filas ya
--     creadas y los tests 005/007 (que insertan `justified` pero no esta
--     columna) siguen funcionando sin cambios.
-- PENDING no se almacena como valor de esta columna: sigue el mismo criterio
-- ya usado para OvertimeDecision/AbsenceDecision — un late_arrival_record sin
-- ninguna late_arrival_decision asociada (source_version vigente) ES el
-- "pendiente", por ausencia de fila, no por un valor explícito.
alter table public.late_arrival_decisions
  add column justification_status text
  generated always as (case when justified then 'JUSTIFIED' else 'NOT_JUSTIFIED' end) stored;

comment on column public.late_arrival_decisions.justification_status is
  'JUSTIFIED/NOT_JUSTIFIED, derivado automáticamente de `justified` (nunca '
  'desincronizable). PENDING no es un valor de esta columna: se representa '
  'por la ausencia de una fila late_arrival_decisions para el late_arrival_record.';

-- `reason` (Fase 2A) ya cumple el rol de comentario del justificativo — no se
-- agrega ningún campo de comentario adicional (sección 18: "si reason ya sirve
-- como comentario, no duplicar campos innecesarios").

-- ---------------------------------------------------------------------------
-- late_arrival_daily_totals — vista, NO tabla ni columna mutable en
-- `employees` (sección 17: explícitamente prohibido un campo tipo
-- `employees.weekly_late_minutes` como fuente de verdad). El acumulado
-- semanal/de período/mensual se obtiene agregando esta vista por rango de
-- fechas (`GROUP BY` en la consulta de reporting, fase futura) — no se
-- materializa aquí ningún total, evitando inconsistencia con el detalle
-- diario y evitando sobreingeniería (no se crea una tabla de agregados).
create view public.late_arrival_daily_totals as
select
  lar.employee_id,
  lar.work_date,
  lar.detected_minutes,
  lad.payroll_minutes,
  lad.justification_status
from public.late_arrival_records lar
left join public.late_arrival_decisions lad
  on lad.late_arrival_record_id = lar.id
  and lad.is_current
where lar.is_current;

comment on view public.late_arrival_daily_totals is
  'Un renglón por trabajador+fecha con el atraso detectado y (si existe '
  'decisión vigente) los minutos que afectan remuneración. Base para agregar '
  '(SUM + GROUP BY rango de fechas) totales semanales/de período/mensuales sin '
  'almacenar ningún acumulado como dato mutable independiente.';
