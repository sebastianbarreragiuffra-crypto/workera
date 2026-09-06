# Excel de asistencia

La exportación está implementada en `src/lib/business-rules/attendance-export.ts` y se ejecuta exclusivamente en el servidor desde `/dashboard/export-asistencia`.

El libro `.xlsx` se genera desde cero para que incorpore automáticamente altas y cambios de padrón. Incluye:

- `RESUMEN`: nómina plana por persona, identificada por código Workera y RUT solo para owner/RR. HH., con días a pagar, descuentos definitivos, HH 50%/100% aprobadas, bono HE automático, totales de empresa y estado de revisión.
- `PENDIENTES`: cola accionable por persona y fecha. Conserva cantidades detectadas, pero estas no entran al descuento ni al pago mientras falte una decisión definitiva.
- hoja mensual (`AGO26`, por ejemplo): matriz diaria compatible con la forma de trabajo histórica de RR. HH., incluida la salida anticipada y el respaldo diario del bono HE.

No se usa una plantilla con nombres reales ni se completa el `.xls` histórico. Las exenciones se muestran sin falsos pendientes, la asistencia nunca puede recalcular a un valor negativo y viáticos queda vacío hasta integrar una fuente autorizada; nunca se inventa un cero. Una ausencia aún disputada o pendiente de respaldo y cualquier hecho anterior al ingreso quedan visibles en `PENDIENTES`, pero fuera de los totales pagables. El bono se lee desde `employee_daily_bonuses`, por lo que no se vuelve a calcular ni se hardcodea en Excel. Los códigos cuyo efecto remuneracional no está definido (actualmente `R`) fallan cerrado y aparecen como pendientes. Las decisiones históricas solo impactan remuneraciones mientras su candidato calculado continúe vigente. Cada fecha exige una última corrida `SUCCEEDED`: la ausencia de corrida, un estado `RUNNING`/`PARTIAL`/`FAILED` o un cambio de corrida mientras se leen los datos marca esa fecha para revisión.

El archivo es un artefacto de lectura: toda corrección se hace en GESTORA y luego se vuelve a exportar. Aunque un período cerrado se rotula como control, la copia inmutable y reproducible mediante snapshot sigue siendo trabajo posterior y no debe simularse editando el libro.
