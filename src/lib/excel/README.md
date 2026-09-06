# Excel de asistencia

La exportación está implementada en `src/lib/business-rules/attendance-export.ts` y se ejecuta exclusivamente en el servidor desde `/dashboard/export-asistencia`.

El libro `.xlsx` se genera desde cero para que incorpore automáticamente altas y cambios de padrón. El estándar 2026 elimina los bloques verticales y usa exactamente tres hojas sin celdas combinadas dentro de sus tablas de datos:

- `RESUMEN_NOMINA`: una fila por persona. Separa los valores automáticos de HH 50%, HH 100% y bonos, los ajustes manuales y sus resultados finales. Conserva además cantidad y fechas de los bonos que originan el monto acumulado.
- `CONTROL_PENDIENTES`: cola accionable por persona y fecha. Conserva cantidades detectadas, pero no las paga ni descuenta mientras falte una decisión definitiva.
- `MATRIZ_DIARIA_SABANA`: una fila por persona y una columna por cada fecha calendario del corte. Contiene únicamente los códigos diarios oficiales.

Las fórmulas auditables principales son `HH50 pagables = HH50 reales + Ajuste HH50/1440`, `HH100 pagables = HH100 reales + Ajuste HH100/1440` y `Bono total = Bono HE automático + Ajuste bono`. Los ajustes de tiempo se ingresan como minutos enteros firmados porque el sistema de fechas 1900 de Excel no representa de forma segura una duración negativa. Toda celda ajustada cambia automáticamente a amarillo; un ajuste sin motivo o un resultado final negativo bloquea el estado.

No se usa una plantilla con nombres reales ni se completa el `.xls` histórico. Una ausencia en trámite, un hecho anterior al ingreso, una corrida no exitosa o una marcación incompleta se representa con `?` en la sábana y queda fuera de los agregados definitivos. En fórmulas, el signo literal se cuenta como `COUNTIF(rango,"~?")`; sin la virgulilla Excel lo trataría como comodín. `R` ya no pertenece al catálogo ni a la leyenda: si aparece en historia se conserva como pendiente rojo para que RR. HH. lo resuelva. “Días con presencia” cuenta `P`, nunca días pagables; `L` y `L-M` se mantienen separados.

El bono se lee desde `employee_daily_bonuses`: monto fijo de $1.000 CLP por trabajador y fecha cuando existen al menos 120 minutos aprobados. Se presenta como `Bono HE automático`; no existen viáticos en esta versión. El centro de costo se obtiene de la unidad organizacional primaria vigente al último día del corte, nunca del grupo operativo por semejanza de nombre. El reporte puede ser consultado por `ADMIN_RRHH` y `SUPER_ADMIN`, pero solo `ADMIN_RRHH` confirma una subida o toma una decisión empresarial.

RR. HH. puede editar cualquier celda visible, comparar el archivo modificado y confirmarlo con motivo. GESTORA guarda el archivo exacto en almacenamiento privado y normaliza solo cambios reconocidos por clave estable. Fórmulas y formato se conservan, pero nunca se ejecutan como datos contables. Los estados operativos son `BLOQUEADO`, `REVISAR`, `LISTO PARA REVISIÓN RR. HH.`, `APROBADO POR RR. HH.` y `CERRADO`; la ausencia de pendientes jamás autoaprueba un pago.
