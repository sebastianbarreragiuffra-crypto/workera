# Excel de asistencia

La exportación está implementada en `src/lib/business-rules/attendance-export.ts` y se ejecuta exclusivamente en el servidor desde `/dashboard/export-asistencia`.

El libro `.xlsx` se genera desde cero para que incorpore automáticamente altas y cambios de padrón. El estándar 2026 elimina los bloques verticales y usa exactamente tres hojas sin celdas combinadas dentro de sus tablas de datos:

- `RESUMEN_NOMINA`: una fila por persona. Separa los valores automáticos de HH 50%, HH 100% y bonos, los ajustes manuales y sus resultados finales. Conserva además cantidad y fechas de los bonos que originan el monto acumulado.
- `CONTROL_PENDIENTES`: cola accionable por persona y fecha. Conserva cantidades detectadas, pero no las paga ni descuenta mientras falte una decisión definitiva.
- `MATRIZ_DIARIA_SABANA`: una fila por persona y una columna por cada fecha calendario del corte. Contiene únicamente los códigos diarios oficiales.

Las fórmulas auditables principales son `HH50_Final = Total_HH_50 + Ajuste_50_Minutos/1440`, `HH100_Final = Total_HH_100 + Ajuste_100_Minutos/1440` y `Bonos_Final = Total_Viaticos_Bonos + Ajuste_Bonos_CLP`. Los ajustes de tiempo se ingresan como minutos enteros firmados porque el sistema de fechas 1900 de Excel no representa de forma segura una duración negativa. Toda celda ajustada cambia automáticamente a amarillo; un ajuste sin motivo o un resultado final negativo bloquea el semáforo.

No se usa una plantilla con nombres reales ni se completa el `.xls` histórico. Una ausencia en trámite, un hecho anterior al ingreso, una corrida no exitosa o una marcación incompleta se representa con `?` en la sábana y queda fuera de los agregados definitivos. En fórmulas, el signo literal se cuenta como `COUNTIF(rango,"~?")`; sin la virgulilla Excel lo trataría como comodín. `R` sigue bloqueando porque aún no tiene efecto remuneracional aprobado. `Dias_Codigo_P_No_Pagables` cuenta presencias y nunca debe usarse como base automática de sueldo; `L` y `L-M` se mantienen separados.

El bono se lee desde `employee_daily_bonuses`: no se recalcula ni se hardcodea en Excel. La columna `Total_Viaticos_Bonos` contiene hoy esos bonos autorizados; no incorpora viáticos hasta que exista una fuente empresarial aprobada. `Centro_Costo` se obtiene de la unidad organizacional primaria vigente al último día del corte, nunca del grupo operativo por semejanza de nombre; si falta, el pago queda bloqueado. El reporte de pre-nómina está reservado a `ADMIN_RRHH` y `SUPER_ADMIN`; además, un RUT o código Workera ausente bloquea el pago.

RR. HH. puede hacer un ajuste de último minuto en el libro, pero debe escribir su motivo. El archivo sigue siendo un control editable: aunque un período cerrado se rotule como aprobado, la copia inmutable y reproducible ligada a `period_snapshots` sigue siendo trabajo posterior y no debe simularse como ya implementada.
