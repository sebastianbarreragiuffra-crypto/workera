# Análisis del Excel real de asistencia — impacto sobre Fase 2

Fuente analizada: `18.02 ASISTENCIA DEL PERSONAL - MARIA VERA (2).xls` (ubicado en `Downloads` del usuario, **no copiado ni modificado** — este documento es el único artefacto producido).

Estado: análisis funcional/técnico. **No se creó ningún esquema, migración ni código de exportación.**

Método: lectura del archivo con SheetJS (Node.js) en modo solo-lectura, ya que el entorno no tiene Python/openpyxl disponible y el archivo es `.xls` binario legado (no soportado por openpyxl). No se guardó ninguna copia del archivo dentro del repo.

---

## 1. Estructura encontrada

**Hojas:** `NOV25` (rango `A1:AW454`) y `MARZO` (rango `A1:BU371`). Cada hoja cubre un **período de pago de ~6 semanas a caballo entre dos meses calendario** (ej. NOV25 va del 16-oct al 30-nov; MARZO va del 16-feb al 5-abr), no una semana ni un mes calendario puro. Esto es un dato **NEEDS_BUSINESS_CONFIRMATION**: hay que confirmar si el ciclo de pago real de la empresa es efectivamente de ~6 semanas, o si estas hojas mezclan dos períodos de pago distintos por conveniencia de una sola planilla.

**Layout de cada hoja (filas, 0-indexado desde la fila del título):**

| Filas | Contenido |
|---|---|
| 0 | Título: "PLANILLA DE ASISTENCIA PERSONAL DE PRODUCCIÓN Y ADMINISTRACIÓN" |
| 1–11 | Leyenda de códigos (ver tabla abajo) |
| 12–13 | Encabezado de fechas: fila 12 = mes, fila 13 = día del mes, una columna por día del período |
| 14 en adelante | Un bloque de **8 filas por trabajador** (algunos bloques tienen 9–10 filas, ver ambigüedad abajo) |

**Bloque por trabajador** (columna A = nombre + horario en texto libre; columna B = etiqueta de fila; columna C = total del período; columnas D en adelante = un valor por día):

1. `Asistencia` — código del día (`P`, `F`, `L`, `V`, etc.) por columna, total en C es **fórmula** `= días_del_período - Vacaciones - Licencia` (confirmado, ej. `14-C16-C18`)
2. `Faltas` — total en C = `SUM(D:AH)` de marcas de falta por día
3. `Vacaciones` — total en C = `SUM(...)`
4. `Licencia` — total en C = `SUM(...)`, y si el trabajador está de licencia, cada día licenciado tiene un `1.00` individual en su columna (confirmado en fila de "VILLANUEVA CRISTOBAL": 15 días de licencia = 15 columnas con `1.00`)
5. `Atrasos` — duración `hh:mm:ss` por día, total en C = `SUM(...)`
6. `HH 50%` — duración `hh:mm:ss` por día (horas extra al 50% de recargo), total en C = `SUM(...)`
7. `HH 100%` — total en C, normalmente sin desglose diario visible en las filas muestreadas
8. `VIATICOS` — monto en `$` por día, total en C = `SUM(...)`. Es un dato de **asignación monetaria de traslado**, no estrictamente de asistencia/horas extra — `NEEDS_BUSINESS_CONFIRMATION`: ¿está dentro del alcance de esta aplicación, o pertenece a otro proceso administrativo?

**Ambigüedad detectada — NEEDS_BUSINESS_CONFIRMATION:** varios trabajadores (ej. "BERRIOS CARLOS") tienen **dos filas `HH 50%` seguidas más una fila `TOTAL 50%`**, en vez del bloque estándar de una sola fila `HH 50%`. No es evidente si esto representa dos categorías distintas de horas extra al 50% (ej. entre semana vs. sábado), un error de plantilla, o una corrección manual que quedó duplicada. No debe asumirse ninguna interpretación sin confirmarlo con quien arma la planilla hoy.

**Leyenda de códigos (fuente: filas 1–11 del propio archivo, no inferida):**

| Código | Significado literal en el archivo |
|---|---|
| `P` | PRESENTE |
| `F` | FALTA |
| `F-P` | FALTA CON PERMISO |
| `F-J` | FALTA JUSTIFICADA |
| `P-L` | PERMISO "LEGAL" |
| `P-M` | PERMISO MATERNAL |
| `V` | VACACIONES |
| `L` | LICENCIA |
| `L-M` | LICENCIA MUTUAL |
| `R` | RECUPERAN HORAS |
| `?` | TARJETA NO MARCADA O CON PROBLEMAS |

**Celdas combinadas:** 57 combinaciones en NOV25 y 47 en MARZO, casi todas en la columna A agrupando las 7–10 filas de cada bloque de trabajador bajo su nombre (un merge por trabajador). Confirma visualmente que el bloque-por-trabajador es la unidad estructural real de la planilla.

**Formato relevante:**
- 7 colores de relleno distintos usados sobre celdas de datos (`00CCFF`, `CCFFFF`, `99CC00`, `FFFF00`, `FFCC00`, `FF9900`, `FF00FF`), sin leyenda de color en el archivo. **NEEDS_BUSINESS_CONFIRMATION**: no se puede asumir su significado (ej. "pendiente de revisión", "ya pagado", "con incidencia") sin preguntar a quien la usa a diario.
- Formatos numéricos: duraciones como `h:mm:ss`, montos como `"$"#,##0`, y un formato `[$-F400]h:mm:ss AM/PM` que produce el efecto visual de valores como `"12:00:00 AM"` para representar una duración de **cero** — es un artefacto conocido de Excel (las duraciones se almacenan como fechas seriales desde 1899-12-31/1900-01-01), no un dato real de hora del día. Relevante para Fase 10: si se lee este archivo históricamente o se genera uno nuevo con duraciones, hay que manejar explícitamente este formato para no confundir "00:00" con una hora de reloj real.

**374 comentarios de celda** (notas de Excel, no de hilo/hoja), prácticamente todos firmados por la misma persona ("ANDREA CACERES", nombre real en el archivo — administración de personal). Esto es central para el punto 2 y se detalla ahí.

---

## 2. Clasificación de qué depende hoy del supervisor/administración

A diferencia del ejemplo conceptual planteado en el encargo, el archivo real **no separa un valor "detectado" de un valor "aprobado" en columnas distintas**. El HH 50%/HH 100% final ya es el número después de cualquier ajuste manual — el ajuste queda documentado únicamente como **texto libre en un comentario de celda**, no como un campo estructurado.

| Dato | Clasificación | Evidencia en el archivo |
|---|---|---|
| Nombre del trabajador, horario contractual | `MANUAL_UNKNOWN` (hoy) → candidato a `AUTOMATIC_FROM_WORKERA` | Texto libre escrito a mano en la celda de nombre, incluye horario y notas de ingreso/práctica mezcladas en el mismo texto |
| Código diario de asistencia (`P`/`F`/`L`/`V`/etc.) | **Mixto**: se **origina** de la marcación del reloj control, pero se **corrige manualmente** con frecuencia (ver comentarios: "se confirma asistencia con portería", "Se pasara por falta justificada") | 374 comentarios documentando correcciones manuales sobre el dato crudo |
| Horas extra (HH 50% / HH 100%) | **Mixto, sin separación estructural**: el valor final ya incluye decisiones humanas ("indicar si se descuenta", "FAVOR DESCONTAR") aplicadas directamente sobre el número, sin dejar el valor original crudo por separado | Comentarios explícitos pidiendo confirmación de descuento antes de que el número quede fijado |
| Atrasos (tardanza) | Igual que horas extra: número final ya "decidido", con comentarios como respaldo narrativo, no como campo de decisión | Comentarios de trabajadores justificando atrasos (cita médica, etc.) adjuntos a la celda de atraso del día |
| Vacaciones / Licencia | Aparece como dato ya confirmado (código `V`/`L` en el día), sin distinguir "Workera/reloj control lo informó" de "RRHH lo verificó" | No se observó ningún caso de vacaciones/licencia en disputa en la muestra revisada |
| Observaciones | `SUPERVISOR_DECISION` / `ADMIN_DECISION`, pero como **comentario de celda**, no como columna | Todos los 374 comentarios son de este tipo |
| Totales por columna C (Asistencia, Faltas, Vacaciones, Licencia, Atrasos, HH 50%, HH 100%, VIATICOS) | `DERIVED_BY_SYSTEM` (dentro del propio Excel) | Confirmado con fórmulas reales: `SUM(D:AH)` por fila, y `Asistencia = días_período − Vacaciones − Licencia` |

**Conclusión clave de esta sección:** el ejemplo conceptual del encargo (`Horas extra registradas → AUTOMATIC_FROM_WORKERA`, `Horas extra aprobadas → SUPERVISOR_DECISION`) **no se cumple hoy en el proceso real** — hoy solo existe **un** número final de horas extra por trabajador/día, ya negociado por email/comentario entre el trabajador, RRHH y presumiblemente el supervisor, sin que el archivo conserve el valor "crudo" original de forma separada. Esto no es un defecto del Excel que haya que replicar; es exactamente el problema que `PRE_FASE2_WORKERA_VALIDATION.md` (sección 8, `original_workera_value ≠ supervisor_decision`) ya anticipó como riesgo y por eso nuestra aplicación debe mejorar este punto, no copiarlo.

---

## 3. Estados funcionales identificados

Del archivo real, los estados diarios que existen **hoy** (no inventados) son exactamente los de la leyenda: `PRESENTE`, `FALTA`, `FALTA_CON_PERMISO`, `FALTA_JUSTIFICADA`, `PERMISO_LEGAL`, `PERMISO_MATERNAL`, `VACACIONES`, `LICENCIA`, `LICENCIA_MUTUAL`, `RECUPERAN_HORAS`, `TARJETA_NO_MARCADA`.

Los estados propuestos en el encargo (`OVERTIME_PENDING`, `OVERTIME_APPROVED`, `OVERTIME_REJECTED`, `NEEDS_REVIEW`, `INCOMPLETE_ATTENDANCE`) **no existen hoy como estados explícitos** — son, correctamente, mejoras que nuestra aplicación introduciría sobre el proceso actual, no una migración 1:1 del Excel. Esto no es un problema: es la brecha exacta que la Fase 2 en adelante debe cerrar. Pero sí significa que el mapeo `código Excel → estado interno` debe diseñarse con cuidado, por ejemplo:

- `TARJETA_NO_MARCADA` (`?`) hoy se resuelve manualmente vía comentario/portería → nuestro equivalente natural es `INCOMPLETE_ATTENDANCE` o `NEEDS_REVIEW`.
- No hay estado explícito de "horas extra pendiente de decisión" porque hoy la decisión ocurre *antes* de que el número entre a la planilla (por email/comentario), no *dentro* de ella. Nuestra app formaliza ese paso previo, que hoy es informal.

---

## 4. Análisis de horas extra (sección crítica)

Confirmado contra el archivo real:

- **No hay distinción de columnas entre "horas trabajadas/detectadas" y "horas autorizadas".** Solo existe `HH 50%` y `HH 100%` (dos tasas de recargo legal, no dos etapas de aprobación), cada una con un único valor final por día.
- **No hay aprobación parcial visible como dato estructurado** — pero **sí ocurre en la práctica**: el comentario en `E64` dice literalmente *"Berrios Carlos marco salida el 17-10 a las 13:10 indicar si se descuenta. FAVOR DESCONTAR"*, es decir, alguien decide manualmente si una marcación cuenta o no, y el número que queda en la celda ya refleja esa decisión — sin dejar rastro de "antes decía X, ahora dice Y".
- **No hay rechazo total como estado explícito** — un rechazo total simplemente se traduce en que esa hora extra "no aparece" en el total, sin registro de que existió una marcación descartada.
- **Totales diarios**: sí existen (una celda por día).
- **Totales del período**: sí existen (columna C, con fórmula `SUM`).
- **Tipos de horas extra**: dos tasas legales (`50%` y `100%`), consistente con la normativa laboral chilena de recargo por horas extraordinarias; posible tercera categoría ambigua por la duplicación de filas `HH 50%` en algunos trabajadores (ver sección 1).

**Sobre el escenario mínimo pedido** (*Workera detecta 1h30m, supervisor aprueba 1h00m, resultado 30 min rechazados*): **el Excel actual NO soporta este escenario como dato estructurado.** Hoy, si alguien decide aprobar solo 1h00m de una marcación de 1h30m, el archivo terminaría mostrando directamente `1:00:00` en la celda de `HH 50%`, con quizás un comentario narrativo explicando por qué, pero **sin conservar el `1:30:00` original en ningún campo**. Esto confirma que el escenario de "valor detectado ≠ valor aprobado, ambos conservados" **es una mejora que nuestra aplicación debe aportar**, no algo que ya exista y debamos replicar. Refuerza directamente la decisión ya tomada en `PRE_FASE2_WORKERA_VALIDATION.md` sección 8.

---

## 5. Vacaciones, licencias y ausencias

En el archivo real, estos datos aparecen **ya consolidados**, sin distinguir "lo que informó el reloj/sistema" de "lo que confirmó RRHH". Ejemplo: el trabajador "VILLANUEVA CRISTOBAL" tiene 15 días marcados `L` (licencia) consecutivos con total `15.00` en la fila resumen — es un dato final, no hay versión previa visible.

No se observó en la muestra revisada ningún caso de conflicto entre "Workera dice vacaciones" vs "supervisor corrigió a otra cosa" — simplemente porque la fuente actual (reloj control + Andrea Cáceres por email) no tiene ese concepto de dos capas. Esto significa que **la regla que ya definimos** — "una decisión manual no debe destruir silenciosamente el dato original" — es una regla nueva que nuestra aplicación introduce como mejora de proceso, y que debe comunicarse como tal al negocio (no es que estemos replicando algo que ya hacían y ahora se nos olvida, es una capacidad que hoy no existe).

---

## 6. Validaciones necesarias

Basado en lo observado (incluyendo evidencia real de los comentarios: marcaciones faltantes, salidas sin entrada registrada, correcciones ad-hoc), propongo la siguiente clasificación. Ninguna de estas existe hoy como validación automática — hoy se detectan manualmente, por eso el archivo tiene 374 comentarios de corrección.

| Validación | Clasificación | Justificación |
|---|---|---|
| Horas extra sin decisión (aprobar/rechazar) | `BLOCKING` | Es el corazón del flujo — no se puede cerrar la semana con horas extra “flotando” |
| Licencia + marcación de asistencia el mismo día | `BLOCKING` | Contradicción directa de estado; visto que el archivo real no tiene forma de detectarlo hoy (todo manual) |
| Vacaciones + horas trabajadas el mismo día | `BLOCKING` | Igual razón que la anterior |
| Vacaciones + horas extra el mismo día | `BLOCKING` | Igual razón |
| Horas extra aprobadas > horas extra registradas | `BLOCKING` | Inconsistencia matemática directa, nunca debería ocurrir en un sistema correcto |
| Salida sin entrada / entrada sin salida | `WARNING` | Confirmado que ocurre hoy con frecuencia (varios comentarios: "no marcó salida", "no marcó entrada") y hoy se resuelve con confirmación de portería o del propio trabajador — no siempre implica un error de datos, puede ser una marcación real pendiente de confirmar |
| Salida anterior a entrada | `BLOCKING` | Inconsistencia lógica que no debería pasar a producción de datos de remuneración |
| Trabajador duplicado | `BLOCKING` | Duplicar un trabajador duplicaría remuneraciones — máxima severidad |
| Registro sin trabajador asociado (empleado inexistente) | `BLOCKING` | No se puede atribuir el dato a nadie |
| Día sin estado (celda vacía donde se esperaba un código) | `WARNING` | Visto en el archivo: hay huecos legítimos (ej. período antes del ingreso del trabajador) junto a huecos que sí son datos faltantes — no se puede tratar como bloqueante sin criterio adicional (ver incógnita en sección 10) |
| Diferencia importante entre horas trabajadas y horas aprobadas | `WARNING` | Señal de que vale la pena revisar, pero no siempre es un error (puede ser un rechazo intencional) |
| Colores de celda sin significado documentado usados como si fueran datos | `INFORMATIONAL` | No podemos migrar un significado que no está confirmado; se deja como nota para no perder la señal visual que el proceso actual sí usa |

---

## 7. Modelo conceptual requerido (sin SQL)

Comparado con el modelo de `PRE_FASE2_WORKERA_VALIDATION.md`, el Excel real **confirma la necesidad de las entidades ya previstas y agrega una entidad nueva** (`DailyReview`/`WeeklyReview` explícitos, y una tabla de observaciones con autor — hoy son comentarios de Excel sin estructura, y eso es justamente lo que hay que resolver).

| Entidad | Propósito | Source of truth | External ID esperado de Workera | Datos internos | Histórico | Relaciones |
|---|---|---|---|---|---|---|
| `Employee` | Datos maestros del trabajador | Workera (con posibilidad de edición administrativa justificada) | Sí, obligatorio | — | No requiere versión histórica en Fase 2 | `SupervisorAssignment`, `AttendanceRecord`, etc. |
| `SupervisorAssignment` | Relación supervisor↔trabajador | **Nuestra base** (ver `PRE_FASE2_WORKERA_VALIDATION.md` sección 6) | Opcional, si Workera lo expone como semilla | `source: workera/internal` | Sí — quién asignó, cuándo | `Employee`, `profiles` (supervisor) |
| `AttendanceRecord` | Marcación/asistencia cruda del día | Workera | Sí, o `(employee_id, date)` si Workera no da ID de registro | — | No se sobrescribe: cada sync guarda su propio valor con timestamp | `Employee` |
| `OvertimeRecord` | Horas extra **detectadas** (valor crudo de Workera), separado por tasa (50%/100%) si Workera lo distingue así | Workera | Sí, o `(employee_id, date, rate_type)` | — | Si Workera cambia el valor después de que ya existe una `OvertimeDecision`, no se sobrescribe: se versiona (ver sección 8) | `Employee`, `OvertimeDecision` |
| `OvertimeDecision` | Decisión del supervisor sobre un `OvertimeRecord`: aprobar todo, aprobar parcial, rechazar | **Nuestra aplicación** | No aplica (es 100% interno) | `decided_minutes`, `status`, `decided_by`, `decided_at`, `observation` | Cada decisión es un registro nuevo si se corrige, nunca un update destructivo | `OvertimeRecord`, `profiles` (supervisor) |
| `AbsenceRecord` | Vacaciones/licencia/permiso/falta — el código diario y su tipo | Workera | Sí, o `(employee_id, date)` | — | Igual criterio que `OvertimeRecord`: cambios posteriores generan alerta, no sobrescritura silenciosa | `Employee` |
| `DailyReview` | Estado de revisión de un trabajador para un día específico (`pending`/`reviewed`/`needs_review`) | **Nuestra aplicación** | No aplica | — | Se deriva de `OvertimeDecision` + confirmaciones de licencia/vacaciones | `Employee`, `AttendanceRecord`, `AbsenceRecord` |
| `WeeklyReview` | Agregado semanal usado para habilitar la generación del Excel (bloquea si hay pendientes) | **Nuestra aplicación** | No aplica | `period_start`, `period_end`, `status` | — | `DailyReview` (N a 1) |
| `AuditLog` | Historial de toda acción relevante | **Nuestra aplicación** | No aplica | Acción, actor, timestamp, valor anterior/nuevo | Es en sí mismo el histórico | Todas las entidades anteriores |
| `WorkeraSyncRun` | Registro de cada corrida de sincronización | **Nuestra aplicación** | No aplica | Rango de fechas, resultado, errores | Es en sí mismo el histórico | — |
| `ExcelExport` | Registro de cada Excel semanal generado | **Nuestra aplicación** | No aplica | Ver sección 9 | Es en sí mismo el histórico | `WeeklyReview` |

Diferencia principal respecto al modelo conceptual previo: se separa explícitamente `OvertimeRecord` (dato crudo) de `OvertimeDecision` (decisión), en vez de un único `OvertimeRecord` con un campo de estado — esto es directamente lo que el Excel real demuestra que falta hoy y que no debe perderse en nuestro diseño.

**No se determina todavía** si `AttendanceRecord`/`OvertimeRecord`/`AbsenceRecord` conviene modelarlos como tablas separadas o como una tabla más genérica de "eventos diarios" — esa es una decisión de Fase 2 propiamente dicha, no de esta etapa de análisis.

---

## 8. Preservación de valor original y decisión humana

El Excel real confirma exactamente el riesgo que ya habíamos anticipado: **hoy no existe preservación del valor original.** El valor final sobrescribe cualquier corrección, con un comentario de texto como único rastro (y los comentarios de Excel, al ser de tipo *note* en formato `.xls`, no tienen historial de ediciones — si alguien edita el comentario, el texto anterior se pierde también).

Regla de diseño confirmada para Fase 2 (ya anticipada, ahora con evidencia real que la justifica):

```
OvertimeRecord.workera_minutes        (inmutable una vez creado por sync; un nuevo valor de Workera crea una nueva versión o marca needs_review, nunca pisa el anterior)
OvertimeDecision.decided_minutes      (explícito, ligado a un OvertimeRecord y a un supervisor)
```

Si Workera cambia `workera_minutes` **después** de que ya exista una `OvertimeDecision` para ese registro, el sistema no debe recalcular ni sobrescribir la decisión — debe marcar el `DailyReview` correspondiente como `needs_review` y dejarlo visible para que un humano lo resuelva, tal como pediste. Este comportamiento no existe hoy en el Excel (hoy simplemente se sobrescribiría el número), así que es una mejora real de proceso, no una paridad de funcionalidad.

---

## 9. Excel semanal como artefacto auditable

Los campos mínimos que propusiste (`weekly_export_id`, `period_start`, `period_end`, `generated_at`, `generated_by`, `template_version`, `validation_status`, `file_hash`) son consistentes con lo observado y **se recomienda mantenerlos todos**. Adicionalmente, dado lo encontrado en el archivo real:

- **Sí conviene guardar un snapshot de datos**: dado que el Excel real muestra que los valores pueden seguir cambiando después de generado (ver comentarios corrigiendo datos de semanas anteriores), sin un snapshot no podríamos responder "¿qué vio exactamente el Excel del 16/08?" si los datos subyacentes cambian después.
- **Sí conviene versionar las decisiones referenciadas**: cada `ExcelExport` debería poder listar qué `OvertimeDecision` (con su ID y timestamp) exactamente usó, no solo "los datos de esa semana" de forma implícita.
- **Versión de plantilla**: crítico — el archivo real tiene una estructura de plantilla específica (bloques de 8 filas, fórmulas, formato de colores) que evolucionará; sin `template_version` no podríamos saber si un Excel viejo se generó con una plantilla que ya cambió.

---

## 10. `.xls` vs `.xlsx` — recomendación

**Recomendación: B — migrar una copia maestra a `.xlsx`, sin alterar el archivo `.xls` original, y generar siempre `.xlsx` desde ahí en adelante.**

Justificación:

| Criterio | `.xls` (legado, formato binario BIFF8) | `.xlsx` (OOXML) |
|---|---|---|
| Compatibilidad con Excel actual | Sí, pero Microsoft lo trata como formato heredado; algunas funciones modernas no aplican | Nativo en todas las versiones actuales |
| Soporte desde Node.js | Limitado: `openpyxl` (Python, que no está disponible en este entorno) no lo soporta en absoluto; en Node, SheetJS puede **leerlo** pero su soporte de **escritura fiel** manteniendo fórmulas/formato exacto es notablemente más frágil que con `.xlsx` | ExcelJS (la librería ya elegida en `ARCHITECTURE.md`) tiene soporte maduro de lectura/escritura preservando fórmulas, formato y hojas |
| Fórmulas | Soportadas, pero el binario es más difícil de editar de forma segura sin corromper la estructura interna | Es XML dentro de un zip — mucho más robusto para edición programática selectiva (lo que necesitamos: rellenar celdas sin destruir el resto) |
| Formato/colores/merges | Presentes y ya identificados en este análisis | Se preservan igual o mejor al editar con ExcelJS |
| Riesgo de corrupción al editar programáticamente | **Alto** para `.xls` — es un formato binario propietario, con librerías de escritura mucho menos confiables | Bajo — es el caso de uso principal de ExcelJS |
| Mantenimiento futuro | Formato descontinuado por Microsoft para nuevos desarrollos | Es el estándar actual y el que ya elegimos en la arquitectura |
| Seguridad | Los `.xls` binarios han tenido más vulnerabilidades históricas de parsing que OOXML | Menor superficie de ataque relativa |

**Cómo aplicarlo sin perder nada:** el equipo (o quien arma hoy la planilla) abre el `.xls` real en Excel y hace "Guardar como" `.xlsx` una sola vez, preservando manualmente fórmulas/formato/colores tal como Excel los migra de forma nativa (Excel hace esta conversión de forma confiable — el riesgo está en que un script automatizado lo haga, no en que Excel mismo lo haga). Esa copia `.xlsx` pasa a ser la plantilla maestra versionada (`template_version` de la sección 9) que ExcelJS rellena en Fase 10. El `.xls` original **no se modifica ni se descarta**, queda como referencia histórica.

**No se realizó esta conversión en esta tarea** — es una recomendación para cuando se apruebe Fase 10, y de todos modos requiere que la propia empresa confirme que esa es la plantilla vigente (ver incógnitas, sección siguiente).

---

## 11. Incógnitas que requieren confirmación del negocio

1. ¿El ciclo de "período" de estas planillas es realmente de ~6 semanas a caballo entre dos meses, o son dos períodos de pago independientes combinados en una sola hoja por conveniencia?
2. ¿Qué significan los 7 colores de relleno usados sobre las celdas de datos? Sin esto no podemos decidir si son un dato a migrar o solo estética.
3. ¿Por qué algunos trabajadores tienen dos filas `HH 50%` + una fila `TOTAL 50%`? ¿Es una categoría real (ej. entre semana vs. sábado) o una inconsistencia de la plantilla?
4. ¿`VIATICOS` debe quedar dentro del alcance de esta aplicación, o es un proceso administrativo aparte que no debería mezclarse con horas extra/asistencia?
5. ¿Quién tiene autoridad real hoy para decidir "se descuenta o no" una marcación — es el supervisor directo, o es RRHH (Andrea Cáceres) quien centraliza esa decisión por email? Esto determina quién debe tener el botón de aprobar/rechazar en nuestra app.
6. Cuando una celda de asistencia está vacía (sin código), ¿siempre significa "el trabajador aún no ingresaba a la empresa" o puede significar también "dato faltante que hay que completar"? Es necesario para decidir si "día sin estado" es `BLOCKING` o `WARNING` en todos los casos.
7. ¿Existen ya reglas legales/internas fijas de cuántos minutos de atraso se toleran antes de descontar, o es siempre criterio caso a caso (como sugieren los comentarios)?
8. ¿La codificación de licencia (`L` vs `L-M`, licencia médica común vs. licencia mutual/accidente laboral) debe tratarse como el mismo tipo de ausencia en nuestro modelo, o deben quedar claramente diferenciadas por sus implicancias legales/de pago?

---

## Impacto sobre `PRE_FASE2_WORKERA_VALIDATION.md`

**No se contradice ninguna decisión ya tomada; se confirma con evidencia real y se agrega precisión:**

- La decisión de que `SupervisorAssignment` sea fuente de verdad interna (sección 6 del documento anterior) **se mantiene sin cambios** — el Excel real no aporta evidencia sobre esto, ya que no expone la jerarquía de supervisores.
- La separación `original_workera_value ≠ supervisor_decision` (sección 8 del documento anterior) **queda confirmada como necesaria y se refuerza**: el Excel real demuestra que, sin esta separación, hoy se pierde información real de forma sistemática (374 comentarios narrando decisiones que no quedan en ningún campo estructurado).
- Se **agrega una entidad no explícita antes**: `OvertimeDecision` como tabla separada de `OvertimeRecord`, en vez de asumir que un único registro de horas extra alcanza con un campo de estado.
- Se **confirma la necesidad de `DailyReview`/`WeeklyReview`** como capa de estado de revisión, ya que hoy ese estado no existe como dato, solo como proceso informal por email/comentario.
