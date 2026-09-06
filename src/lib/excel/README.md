# Excel de asistencia

La exportación está implementada en `src/lib/business-rules/attendance-export.ts` y se ejecuta exclusivamente en el servidor desde `/dashboard/export-asistencia`.

El libro `.xlsx` se genera desde cero para que incorpore automáticamente altas y cambios de padrón. Incluye:

- `RESUMEN`: vista operativa para remuneraciones, con atrasos, salidas anticipadas, marcaciones incompletas, ausencias/licencias abiertas, horas extra, corridas incompletas del motor, fechas pendientes y estado del período.
- hoja mensual (`AGO26`, por ejemplo): matriz diaria compatible con la forma de trabajo histórica de RR. HH.

No se usa una plantilla con nombres reales ni se completa el `.xls` histórico. Las exenciones se muestran sin falsos pendientes, la asistencia nunca puede recalcular a un valor negativo y viáticos queda vacío hasta integrar una fuente autorizada; nunca se inventa un cero. Las decisiones históricas solo impactan remuneraciones mientras su candidato calculado continúe vigente. Cada fecha exige una última corrida `SUCCEEDED`: la ausencia de corrida, un estado `RUNNING`/`PARTIAL`/`FAILED` o un cambio de corrida mientras se leen los datos marca esa fecha para revisión.
