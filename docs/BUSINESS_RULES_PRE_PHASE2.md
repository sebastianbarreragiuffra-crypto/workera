# Especificación de reglas de negocio — pre-Fase 2

**Versión 2** de este documento. Reemplaza y consolida la versión anterior (commit `0b568fb`) incorporando: modelo organizacional Administración/Producción, horarios formalizados, elegibilidad y fórmula de horas extra, regla de tope de 120 minutos, tratamiento de clock-out tardío, atrasos diarios/acumulados, y requisitos futuros de dashboard/tests. No se elimina contenido de los documentos anteriores — donde este documento reemplaza una sección previa, se indica explícitamente.

Se apoya en, y no contradice:
- `docs/PRE_FASE2_WORKERA_VALIDATION.md`
- `docs/EXCEL_WORKFLOW_ANALYSIS.md`

**No contiene DDL, migraciones, UI ni integración con Workera.** Es la especificación funcional que Fase 2 usará para diseñar PostgreSQL.

**Contradicciones encontradas entre documentos:** ninguna. Las reglas nuevas de este documento (Administración/Producción, horarios, fórmula de overtime, atrasos) son una **extensión** de lo ya decidido (hecho≠cálculo≠decisión, `OvertimeRecord`/`OvertimeDecision` separados, `SYNC_CONFLICT`, cierre semanal), no una revisión de esas decisiones.

---

## 0. Principio fundamental — HECHO ≠ CÁLCULO ≠ DECISIÓN

Reafirmado sin cambios respecto a la v1 de este documento, ahora aplicado también a horas extra de Producción y a atrasos con fórmulas concretas:

```
DATO ORIGINAL DE WORKERA (ej. clock_out = 19:32)
        ↓  inmutable; si cambia después de una decisión, ver sección 15 (SYNC_CONFLICT)
INTERPRETACIÓN / CÁLCULO DEL SISTEMA (ej. overtime_candidate = 120 min)
        ↓  derivado por una POLICY centralizada (sección 12), nunca hardcodeado inline
DECISIÓN HUMANA (ej. approved_overtime = 60 min)
        ↓  con cantidad, actor, timestamp y motivo — nunca un booleano
RESULTADO FINAL (lo que entra al Excel de una semana CLOSED)
```

---

## 1. Organizational Model — Administración vs Producción

**Decisión:** se introduce `EmployeeGroup` como el concepto operativo que **efectivamente conduce las reglas de negocio** (elegibilidad de horas extra, políticas aplicables), y se mantiene `department`/`cost_center` como **metadata descriptiva** proveniente de Workera, sin lógica de negocio atada directamente a ellos.

Razonamiento sobre las cuatro alternativas planteadas (`department`, `employee_group`, `organizational_unit`, `cost_center`):

- **`department`/`cost_center`**: son atributos informativos de Workera (para reporting, agrupación visual), no deberían ser la fuente de la que dependa una regla como "¿tiene derecho a horas extra?" — si Workera cambia el nombre de un departamento o crea uno nuevo, no querémos que eso silenciosamente active o desactive elegibilidad de horas extra.
- **`organizational_unit` genérico**: es la abstracción más flexible a largo plazo (permite jerarquías: empresa → sucursal → área → cuadrilla), pero es sobre-ingeniería para el requisito actual, que solo necesita distinguir dos grupos con reglas distintas. Se documenta como evolución posible, no se implementa ahora.
- **`employee_group` — elegido**: un catálogo controlado y pequeño (`ADMINISTRATION`, `PRODUCTION`, extensible sin migración de esquema si se agrega un tercer grupo) que es **el punto de enganche real de las políticas** (`OvertimePolicy`, sección 12). Cada `WorkSchedule`/`OvertimePolicy` se asocia a un `employee_group`, no a un `department` de texto libre.

**Regla de elegibilidad confirmada:**

```
PRODUCTION      → overtime_eligible = true (sujeto a política, sección 5-8)
ADMINISTRATION  → overtime_eligible = false (dentro de este proceso)
```

Todo `Employee` debe tener un `employee_group` asignado; un trabajador sin clasificación organizacional es una validación `BLOCKING` (sección 18) — sin esto, el sistema no puede saber qué política de horas extra aplicar, y calcular candidatos de horas extra para alguien sin grupo sería inventar una regla.

---

## 2. Fuente del `employee_group` (actualiza `PRE_FASE2_WORKERA_VALIDATION.md` sección 5-6)

Mismo patrón ya decidido para `SupervisorAssignment`, aplicado aquí:

```
Si Workera entrega un campo de departamento/grupo confiable y estable:
    → se usa como semilla para poblar employee_group automáticamente en cada sync
Si Workera no lo entrega, o no es confiable/estable:
    → employee_group se administra manualmente en nuestra base (solo admin)
En ambos casos:
    → un admin puede corregir manualmente la asignación sin que el siguiente
      sync la sobrescriba silenciosamente (mismo principio que supervisor↔trabajador)
```

**No se asume que Workera entrega esto de forma confiable** — es la pregunta P1 #6 de la sección 22. Hasta confirmarlo, el diseño de Fase 2 debe soportar ambos orígenes (`source: workera | internal` en la asignación, igual que `SupervisorAssignment`).

---

## 3. Work Schedules — horarios formalizados

Horario actual (dato real proporcionado, no inventado):

| Día | Entrada | Salida |
|---|---|---|
| Lunes | 07:30 | 17:00 |
| Martes | 07:30 | 17:00 |
| Miércoles | 07:30 | 17:00 |
| Jueves | 07:30 | 17:00 |
| Viernes | 07:30 | 14:50 |

**Decisión de modelo:** `WorkSchedule` (una jornada nombrada, ej. "Horario estándar planta") compuesta de reglas por día de la semana (`scheduled_start`/`scheduled_end`, nulos si no corresponde trabajar ese día), y `ScheduleAssignment` que vincula un `Employee` a un `WorkSchedule` con vigencia (`effective_from`/`effective_to`), no un campo fijo en `Employee`. Motivo: el Excel real ya muestra horarios distintos escritos en el texto libre del nombre de cada trabajador (algunos con horario de colación distinto, algunos con fecha de ingreso o práctica) — si el horario fuera un campo fijo en `Employee`, un cambio de turno no dejaría rastro de cuál era el horario vigente en una fecha pasada, rompiendo la trazabilidad de una decisión de horas extra tomada bajo el horario anterior.

**Regla explícita del encargo, ya satisfecha por este diseño:** el horario **nunca se hardcodea en código de aplicación** (nada como `if (hour > 17)` disperso en varios archivos) — vive como datos en `WorkSchedule`, consumidos por `OvertimePolicy`/`LateArrivalPolicy` (sección 12).

---

## 4. Attendance — hecho crudo

Sin cambios respecto al documento anterior: `AttendanceRecord` guarda `clock_in`/`clock_out` reales tal como los entrega Workera, y `AttendanceCorrection` (sección 11) es el único mecanismo para corregirlos, preservando siempre el valor original.

**Regla reafirmada explícitamente por el encargo (crítica, sección 7 de la conversación):** el valor de `clock_out` real **siempre se conserva tal cual**, sin importar cuán tarde sea, incluso cuando exceda largamente el tope de horas extra candidatas. Ver sección 6 para el ejemplo concreto (19:43 real conservado, 120 min como candidato).

---

## 5. Overtime Eligibility — elegibilidad de horas extra

```
employee_group = PRODUCTION      → overtime_eligible = true
employee_group = ADMINISTRATION  → overtime_eligible = false
```

**Ejemplo confirmado del encargo:** un trabajador de Administración con jornada 07:30→17:00 que marca salida a las 19:00 **no genera ningún candidato de horas extra**. Su `clock_out = 19:00` se guarda igual en `AttendanceRecord` (el hecho no se descarta ni se altera), pero **no se crea ningún `OvertimeRecord`** para ese día — la elegibilidad se evalúa antes de calcular el candidato, no después. Esto evita el riesgo de "calcular igual y luego descartar", que dejaría un registro fantasma sin sentido de negocio.

La elegibilidad es un atributo resuelto por la política (`OvertimePolicy`, sección 12) asociada al `employee_group` (y, cuando se confirme la regla de viernes, también al día de la semana — sección 8), no un booleano fijo en `Employee`.

---

## 6. Production Overtime Rules — reglas de horas extra de Producción

**Fórmula conceptual confirmada (lunes a jueves; viernes es `P0`, ver sección 8):**

```
raw_overtime_minutes = clock_out − scheduled_end        (solo si clock_out > scheduled_end)

candidate_overtime_minutes = MAX(0, MIN(raw_overtime_minutes, max_overtime_minutes))
```

Con `scheduled_end = 17:00` (lunes-jueves) y `max_overtime_minutes = 120` (regla actual, configurable — ver `OvertimePolicy`, sección 12):

| Salida real | Candidato de horas extra |
|---|---|
| 17:00 | 0 min |
| 17:30 | 30 min |
| 18:00 | 60 min |
| 18:30 | 90 min |
| 19:00 | 120 min |
| 19:01 | 120 min (tope aplicado) |
| 19:45 | 120 min (tope aplicado) |
| 22:00 | 120 min (tope aplicado) |

**Esto es explícitamente un `OVERTIME_CANDIDATE`, calculado por el sistema (capa "cálculo" del principio de la sección 0) — nunca un `OVERTIME_APPROVED`.** La aprobación (con cantidad, no booleano) es una decisión humana posterior, ya formalizada en `OvertimeDecision` (documento anterior, sin cambios).

---

## 7. Clock-out posterior al límite permitido (>19:00) — regla crítica confirmada

Contexto real proporcionado: los trabajadores de Producción permanecen en las instalaciones después de su jornada más el margen de horas extra para bañarse/cambiarse, por lo que el reloj control puede marcar salidas mucho más tarde que el tiempo efectivamente trabajado.

**Regla:**

```
AttendanceRecord.clock_out         = 19:43   (se conserva exactamente, siempre)
OvertimeRecord.candidate_minutes   = 120     (tope aplicado por la fórmula de la sección 6,
                                               NO 163 minutos)
```

El tope (`MIN(raw_overtime, max_overtime_minutes)`) ya resuelve esto matemáticamente — no se necesita una regla especial adicional, siempre que `max_overtime_minutes` esté correctamente configurado en la política (120 min hoy). Es importante que el equipo de desarrollo en Fase 2 no "optimice" esto sumando el tiempo real completo como horas extra: el diseño **exige** que el candidato quede topado y el valor real quede intacto en un campo separado, exactamente como pide el encargo.

---

## 8. Viernes y horas extra — `P0_BUSINESS_CONFIRMATION`

**No se asume ninguna regla para el viernes.** La jornada de viernes termina a las 14:50, pero no tenemos confirmación de si:
- Producción puede generar horas extra el viernes,
- si aplica el mismo tope de 120 min o uno distinto,
- si la tasa (50%/100%, sección 9) es distinta a la de lunes-jueves (posible, dado que muchos regímenes laborales tratan el viernes/sábado de forma diferenciada).

**Diseño exigido y ya satisfecho:** `OvertimePolicy` (sección 12) incluye `day_of_week` como parte de su clave — es decir, la política se define **por día de la semana**, no como una única regla global. Esto permite que, cuando se confirme la regla de viernes, simplemente se agregue/edite una fila de política para `day_of_week = FRIDAY` sin cambiar la estructura de tablas ni el código de cálculo. Marcado como **P0** en la sección 22 — bloquea poder calcular correctamente (aunque no bloquea diseñar la tabla `OvertimePolicy` en sí).

---

## 9. HH 50% / HH 100%

Sin cambios estructurales respecto al documento anterior (`OvertimeRecord` con `rate_type` como valor de catálogo, no columna fija — un día puede tener ambos tipos simultáneamente, cada uno con su propio candidato/decisión). Se confirma con el ejemplo del encargo:

```
Juan Pérez — 17/08/2026
OvertimeRecord(rate_type=OVERTIME_50,  candidate_minutes=120) → OvertimeDecision(approved_minutes=60)
OvertimeRecord(rate_type=OVERTIME_100, candidate_minutes=60)  → OvertimeDecision(approved_minutes=60)
```

**No se conoce todavía la regla que determina cuándo corresponde 50% y cuándo 100%** (¿día de semana vs. fin de semana/feriado? ¿exceso sobre un segundo umbral dentro del mismo día?). Esto es **P0** (sección 22) y es, junto con la regla de viernes, la pregunta más urgente a resolver con RRHH porque condiciona directamente cómo se calcula `rate_type` al crear un `OvertimeRecord`.

---

## 10. Aprobación parcial

Sin cambios respecto al documento anterior — reafirmado con el ejemplo exacto del encargo:

```
OvertimeRecord.candidate_minutes  = 120
OvertimeDecision.approved_minutes = 90
OvertimeDecision.rejected_minutes = 30   (persistido, no solo derivado en consulta)
```

`approved_minutes` nunca puede exceder `candidate_minutes` — constraint de integridad, no solo validación de UI (ya establecido, reafirmado aquí como no negociable).

---

## 11. Late Arrivals — atrasos diarios y acumulados

**Fórmula conceptual:**

```
late_minutes_detected = MAX(0, (clock_in − scheduled_start) − late_tolerance_minutes)
```

Con `scheduled_start = 07:30` y, hasta nueva confirmación, **`late_tolerance_minutes = 0`** (ver sección 13 — no se asume tolerancia):

| Entrada real | Atraso detectado |
|---|---|
| 07:05 | 0 min (llegó antes — nunca genera un valor negativo ni horas extra, sección 14) |
| 07:15 | 0 min* |
| 07:29 | 0 min |
| 07:30 | 0 min |
| 07:31 | 1 min |
| 07:42 | 12 min |
| 07:45 | 15 min |
| 08:00 | 30 min |

\* `07:15` da 0 min porque es **antes** de `07:30`, no por tolerancia — con `tolerance=0` el resultado sería el mismo, pero conceptualmente son dos motivos distintos (llegada anticipada vs. tolerancia real) y no deben confundirse cuando se implemente.

**El atraso se registra diariamente (`LateArrivalRecord` por fecha), nunca solo como un total acumulado.** Los totales (semanal, de período de pago, mensual) se **derivan por consulta** (`SUM` sobre el rango de fechas correspondiente), nunca se guardan como un campo editable independiente — así el total siempre es recalculable y consistente con el detalle diario, replicando en el modelo lo que en el Excel real ya es una fórmula (`SUM(D:AH)`), pero ahora también disponible a nivel semanal/mensual sin depender de qué columnas estaban incluidas en una planilla específica.

---

## 12. Políticas centralizadas — `AttendancePolicy` / `OvertimePolicy` / `LateArrivalPolicy`

**Decisión de diseño explícitamente exigida por el encargo: ninguna regla vive hardcodeada en código de aplicación.**

```
OvertimePolicy
  employee_group          (PRODUCTION, ADMINISTRATION, ...)
  day_of_week              (MONDAY..SUNDAY — permite reglas distintas por día, sección 8)
  overtime_eligible        (boolean, resuelve la sección 5)
  overtime_start           (normalmente = scheduled_end del WorkSchedule vigente, pero
                             configurable por si difiere)
  max_overtime_minutes     (120 hoy, configurable)
  rate_type_rule           (pendiente de definición exacta — P0, sección 9; el campo existe
                             desde ya para no tener que rediseñar la tabla cuando se confirme)

LateArrivalPolicy
  employee_group
  late_tolerance_minutes   (0 hoy, configurable — sección 13)

AttendancePolicy
  (agrupador conceptual si en el futuro se necesitan reglas de asistencia que no encajen
   en overtime ni en atrasos — no se define contenido propio todavía, evita tener que
   inventar una tabla nueva para la primera regla de este tipo que aparezca)
```

Estas políticas son **datos configurables por un admin**, no líneas de código — satisface directamente el requisito de "evitar hardcoding" y "mantenibilidad" del encargo. El cálculo de `OvertimeRecord`/`LateArrivalRecord` en el backend **lee** estas políticas, nunca las reimplementa condicionalmente por caso.

---

## 13. Tolerancia de atrasos — sin asumir, documentado como configurable

**Hasta confirmación de negocio: `late_tolerance_minutes = 0`.** No se asume ningún valor de tolerancia (5/10/15 min) sin que RRHH lo confirme explícitamente — asumir un valor sin respaldo sería exactamente el tipo de "regla inventada" que el encargo pide evitar. El campo existe en `LateArrivalPolicy` (sección 12) precisamente para que, cuando se confirme un valor distinto de 0, sea un cambio de dato, no una migración de esquema ni un cambio de código.

---

## 14. Llegada antes del horario — sin generar horas extra automáticas

```
clock_in = 07:05  (antes de scheduled_start = 07:30)
→ late_minutes_detected = 0
→ NO se crea ningún OvertimeRecord por esto
```

Llegar temprano nunca es, por sí solo, un hecho que dispare un cálculo de horas extra — las horas extra solo se calculan a partir de `clock_out` tardío (sección 6), no de `clock_in` temprano. Esta distinción se aplica en la lógica de cálculo (consumidora de `OvertimePolicy`), no requiere una tabla ni columna adicional.

---

## 15. Vacation / Absences / Medical Leave (actualiza `PRE_FASE2_WORKERA_VALIDATION.md` y la v1 de este documento)

**Vacaciones:** si Workera informa `VACATION`, la aplicación lo muestra directamente — el supervisor **confirma** o **marca inconsistencia** (ej. "Workera dice vacaciones pero hay marcación de asistencia ese día"), nunca tiene que volver a escribir manualmente un dato que Workera ya entrega. Esto se resuelve con `AbsenceDecision` (ya definida en la v1): su rol principal para vacaciones/licencias no es "decidir cuánto", como en horas extra, sino **confirmar o disputar** el dato importado.

**Licencias — `MEDICAL_LEAVE` vs `WORK_ACCIDENT_LEAVE` (mutual):** se mantienen como tipos separados (decisión ya tomada en la v1, sección 4, sin cambios), porque legalmente tienen tratamiento distinto en Chile. Campos mínimos, aplicando minimización de datos de forma explícita:

```
AbsenceRecord.type         (MEDICAL_LEAVE | WORK_ACCIDENT_LEAVE | VACATION | PERMISSION | ...)
AbsenceRecord.start_date
AbsenceRecord.end_date
AbsenceRecord.source       (workera | internal)
```

**Nunca se almacena diagnóstico, enfermedad ni detalle médico** — reafirmado explícitamente, sin excepción, incluso si Workera lo expusiera.

**Ausencias y permisos:** `ABSENT`, `PERMISSION`, `DAY_OFF`, `HOLIDAY`, `UNKNOWN`, `NEEDS_REVIEW` se mantienen como **nombres conceptuales, no un enum de código cerrado todavía** — el encargo pide explícitamente no fijarlos hasta confirmar qué estados usa realmente Workera y la empresa (pregunta abierta, no bloqueante — sección 22).

---

## 16. Corrections — correcciones manuales

Sin cambios respecto a la v1: patrón `original_value` / `corrected_value` / `correction_reason` / `corrected_by` / `corrected_at` vía `AttendanceCorrection`, reemplazando el mecanismo de comentarios libres del Excel real. Ejemplo del encargo (`clock_out` no marcado, corregido a 18:30 con motivo) es funcionalmente idéntico al ya documentado en la v1 sección 5 — sin necesidad de cambios.

---

## 17. Payroll Decisions — "se descuenta / no se descuenta"

Sin cambios respecto a la v1 (sección 6 de la versión anterior): la decisión de descuento **no** es una entidad nueva ni vive en `DailyReview`; es un atributo (`payroll_effect: DEDUCT | DO_NOT_DEDUCT | NEEDS_REVIEW`) de la decisión específica que la origina (`LateArrivalDecision` principalmente, o `AttendanceCorrection` cuando aplica). Se reafirma esta recomendación tras revisar nuevamente las tres alternativas (`DailyReview` / entidad genérica `PayrollAdjustmentDecision` / decisión específica) — el razonamiento no cambia con las reglas nuevas de esta versión.

---

## 18. Modelo conceptual de entidades (evaluación, no aceptación automática)

Se evalúa nuevamente la lista propuesta, ahora incluyendo `OrganizationalUnit`/`EmployeeGroup` y `WorkSchedule`/`ScheduleAssignment`:

| Entidad | ¿Se mantiene? | Nota |
|---|---|---|
| `Employee` | Sí | Sin cambios |
| `EmployeeGroup` | **Nueva**, reemplaza el `OrganizationalUnit` genérico propuesto en el encargo | Ver sección 1 — se prefiere el catálogo pequeño y específico sobre una jerarquía genérica no requerida hoy |
| `SupervisorAssignment` | Sí | Sin cambios |
| `WorkSchedule` | **Nueva** | Ver sección 3 |
| `ScheduleAssignment` | **Nueva** | Ver sección 3 — vigencia temporal, no campo fijo en `Employee` |
| `OvertimePolicy` | **Nueva**, reemplaza cualquier lógica condicional en código | Ver sección 12 |
| `LateArrivalPolicy` | **Nueva** | Ver sección 12 |
| `AttendanceRecord` | Sí | Sin cambios |
| `AttendanceCorrection` | Sí | Sin cambios |
| `OvertimeRecord` | Sí | Ahora con `candidate_minutes` calculado explícitamente vía `OvertimePolicy`, no solo "detectado de Workera" — el cálculo puede originarse en nuestro backend, no necesariamente en Workera (ver sección 21 fuente de verdad) |
| `OvertimeDecision` | Sí | Sin cambios |
| `AbsenceRecord` | Sí | Sin cambios |
| `AbsenceDecision` | Sí | Su rol principal clarificado en sección 15: confirmar/disputar, no "aprobar cantidad" |
| `LateArrivalRecord` | Sí | Con fórmula explícita (sección 11) |
| `LateArrivalDecision` | Sí | Incluye `payroll_effect` (sección 17) |
| `DailyReview` | Sí | Sin cambios |
| `WeeklyReview` | Sí | Sin cambios |
| `AuditLog` | Sí | Sin cambios |
| `SyncRun` | Sí | Sin cambios |
| `ExcelExport` | Sí | Sin cambios |

**`Decision` genérica vs. entidades específicas — se reafirma la decisión de la v1 sin cambios**: entidades específicas (`OvertimeDecision`, `LateArrivalDecision`, `AbsenceDecision`), por las mismas razones de type safety y constraints ya expuestas (una tabla polimórfica no permite `CHECK (approved_minutes <= candidate_minutes)` a nivel de base de datos). Las reglas nuevas de esta versión (horarios, políticas, atrasos con fórmula) no cambian este razonamiento — si acaso lo refuerzan, porque cada tipo de decisión ahora tiene también su propia fórmula de origen (`OvertimePolicy` vs. `LateArrivalPolicy`), que sería aún más difícil de representar en una tabla genérica.

No se agrega ninguna entidad para Viáticos (sección 20, sin cambios respecto a la v1).

---

## 19. Máquina de estados diaria y semanal

Sin cambios respecto a la v1 (`IMPORTED → PENDING_REVIEW → REVIEWED → READY_FOR_WEEKLY_CLOSE`, con `NEEDS_REVIEW`/`SYNC_CONFLICT`/`CORRECTED_AFTER_REVIEW` como casos no lineales; `WeeklyReview`: `OPEN → READY_TO_CLOSE → CLOSED → REOPENED`). Se agrega una precisión pedida explícitamente por el encargo:

**Un `WeeklyReview` no puede pasar a `CLOSED` si existe algún `DailyReview` del período en un estado con validaciones `BLOCKING` sin resolver** (sección 20) — no solo `NEEDS_REVIEW`/`SYNC_CONFLICT` genéricos, sino específicamente cualquier violación de una regla `BLOCKING`. Esto ya estaba implícito en la v1; aquí queda explícito porque el encargo lo pide como regla propia ("Un período no puede pasar a CLOSED si existen errores BLOCKING").

---

## 20. Validaciones — BLOCKING / WARNING / INFORMATIONAL

Se actualiza la tabla de `EXCEL_WORKFLOW_ANALYSIS.md` sección 6 agregando las reglas nuevas de esta etapa:

| Validación | Clasificación | Nota |
|---|---|---|
| Horas extra sin decisión | `BLOCKING` | Sin cambios |
| Licencia + horas trabajadas el mismo día | `BLOCKING` | Sin cambios |
| Vacaciones + horas trabajadas | `BLOCKING` | Sin cambios |
| Vacaciones + horas extra | `BLOCKING` | Sin cambios |
| Horas aprobadas > horas candidatas | `BLOCKING` | Ya era `BLOCKING`; ahora además es una constraint de integridad (sección 10) |
| Trabajador duplicado | `BLOCKING` | Sin cambios |
| Registro sin trabajador asociado | `BLOCKING` | Sin cambios |
| Salida anterior a entrada | `BLOCKING` | Sin cambios |
| `SYNC_CONFLICT` sin resolver | `BLOCKING` | **Nuevo, explícito** — antes se mencionaba como bloqueo de cierre semanal, ahora se formaliza como validación propia |
| Trabajador sin clasificación organizacional (`employee_group`) | `BLOCKING` | **Nuevo** — sin esto no se puede calcular horas extra correctamente (sección 1) |
| Entrada/salida faltante (marcación incompleta) | `WARNING` | Sin cambios |
| Día sin estado | `WARNING` | Sin cambios |
| Diferencia importante entre horas trabajadas y aprobadas | `WARNING` | Sin cambios |
| Colores de Excel sin significado documentado | `INFORMATIONAL` | Sin cambios |

---

## 21. Source of truth (actualizada)

| Categoría | Fuente de verdad | Estado |
|---|---|---|
| Empleado | Workera | Confirmado |
| Marcaciones | Workera | Confirmado |
| `employee_group` (Administración/Producción) | Workera si es confiable; si no, nuestra base | **Por confirmar (P1)** — sección 2 |
| Jornada (`WorkSchedule`) | Configuración interna, sembrada manualmente con los horarios reales conocidos | El horario ya es un dato real conocido (sección 3); no depende de Workera para existir, aunque Workera podría confirmarlo a futuro |
| Vacaciones | Workera, si disponible | Confirmado, sin cambios |
| Licencias | Workera, si disponible | Confirmado, sin cambios |
| Horas extra candidatas (`OvertimeRecord.candidate_minutes`) | **Cálculo interno**, a partir de `AttendanceRecord` + `OvertimePolicy` | Aclarado en esta versión: no es un dato que Workera entregue ya calculado, salvo que se confirme lo contrario (mismo P0 de `PRE_FASE2_WORKERA_VALIDATION.md`) |
| HH 50% / HH 100% (clasificación de tasa) | **Por confirmar (P0)** | Sección 9 |
| Atrasos detectados | **Cálculo interno**, a partir de `AttendanceRecord` + `LateArrivalPolicy` | Aclarado en esta versión — mismo criterio que horas extra |
| Aprobación de horas extra | Supervisor | Confirmado |
| Atrasos justificados | Supervisor/Admin | Confirmado |
| Correcciones | Supervisor/Admin | Confirmado |
| Descuento/no descuento | Según autoridad definida — **por confirmar (P0)** quién exactamente | Sección 22 |
| Auditoría | Nuestra base | Confirmado |
| Cierre semanal | Nuestra base | Confirmado |
| Excel final | Nuestra aplicación, solo desde `WeeklyReview CLOSED` | Confirmado |

---

## 22. Preguntas de negocio — P0/P1/P2 (consolidado y reclasificado)

Se consolidan las preguntas de la v1 con las nuevas de esta etapa, eliminando duplicados. Reclasificación explícita donde corresponde, con justificación.

### P0 — bloquean el cálculo correcto (no necesariamente la estructura de tablas, ver sección 23)

| # | Pregunta | Origen |
|---|---|---|
| 1 | ¿Qué determina exactamente si una hora extra es `HH 50%` o `HH 100%`? | Nueva (sección 9) |
| 2 | ¿Qué regla de horas extra aplica los viernes (jornada 07:30-14:50)? | Nueva (sección 8) |
| 3 | ¿Quién tiene autoridad final para aprobar horas extra — supervisor directo o RRHH centralizado? | v1, reafirmada |
| 4 | ¿Quién decide "se descuenta / no se descuenta"? | v1, reafirmada |
| 5 | ¿Es correcto asumir que la aprobación parcial de horas extra debe soportarse siempre, o es una excepción rara? | Nueva, aunque el diseño ya la soporta estructuralmente (sección 10) — se mantiene P0 porque afecta si el flujo por defecto de UI (fase futura) debe asumir "todo o nada" con parcial como excepción, o al revés |
| 6 | ¿Cómo se diferencia licencia médica de mutual en el proceso real (más allá del tipo ya modelado)? | v1, reafirmada |
| 7 | ¿Workera calcula horas extra/atrasos, o solo entrega marcaciones crudas? | `PRE_FASE2_WORKERA_VALIDATION.md`, reafirmada — condiciona directamente la sección 21 de este documento |
| 8 | ¿Cuál es el ciclo real de pago/revisión — semanal, o el período de ~6 semanas visto en el Excel real? | v1, reafirmada — sigue sin resolverse |

### P1 — importantes antes de implementación, no bloquean el diseño estructural

| # | Pregunta | Origen |
|---|---|---|
| 9 | ¿Existe tolerancia real para atrasos (5/10/15 min), o es 0 como se asume por defecto? | Nueva (sección 13) |
| 10 | ¿Puede un supervisor corregir una marcación, o solo confirmarla/reportarla para que admin corrija? | v1, reclasificada de "quién corrige" a pregunta específica de permisos |
| 11 | ¿Quién puede reabrir una semana cerrada? | v1, reafirmada |
| 12 | ¿Qué debe ocurrir operativamente si Workera cambia datos después del cierre semanal (más allá de que quede auditado — sección 19)? | v1, reafirmada |
| 13 | ¿Cómo se asignan realmente los trabajadores a supervisores hoy (para validar la decisión de la sección 6 de `PRE_FASE2_WORKERA_VALIDATION.md`)? | v1, reafirmada |
| 14 | ¿Workera entrega Administración/Producción (o equivalente) de forma confiable? | Nueva (sección 2) |

**Reclasificación:** "¿Quién puede corregir una aprobación ya cerrada?" (P1 en la lista del encargo) se **fusiona** con la pregunta 11 (reabrir semana cerrada) — son la misma pregunta de negocio, ya que corregir algo dentro de una semana `CLOSED` requiere pasar por `REOPENED` (sección 19); no se listan como preguntas separadas para no duplicar.

### P2 — sin impacto estructural conocido

| # | Pregunta |
|---|---|
| 15 | ¿Viáticos entrará en el alcance de la aplicación? |
| 16 | ¿Los 7 colores del Excel actual deben conservar significado en la nueva aplicación? |
| 17 | ¿Se necesitan históricos mensuales/anuales dentro del dashboard? |
| 18 | Vocabulario final exacto de los nombres de estado de ausencia (`ABSENT`/`PERMISSION`/etc.) |
| 19 | ¿Por qué algunos trabajadores del Excel real tienen filas `HH 50%` duplicadas + `TOTAL 50%`? |

---

## 23. Future UI Requirements (documentación de requisitos, no implementación)

**No se implementa ninguna UI en esta etapa.** Se documentan los requisitos funcionales para fases futuras (Fase 6 en adelante):

**Dashboard diario — debe separar Producción de Administración**, reflejando que tienen reglas distintas (una tiene horas extra, la otra no):

```
REVISIÓN DIARIA — 17/08/2026

PRODUCCIÓN                       ADMINISTRACIÓN
42 trabajadores                  15 trabajadores
8 horas extra pendientes         2 atrasos
3 atrasos                        1 licencia
1 ausencia
```

**Filtros mínimos requeridos:** Todos, Producción, Administración, Pendientes, Horas extra, Atrasos, Licencias, Vacaciones, Ausencias, Conflictos (`SYNC_CONFLICT`).

**Vista de trabajador — Producción** (con acciones de horas extra, coherente con `OvertimeDecision`):

```
JUAN PÉREZ — PRODUCCIÓN
Jornada: 07:30 - 17:00
Entrada: 07:34   Atraso: 4 min
Salida: 19:36    Hora extra candidata: 2h00

[ APROBAR ] [ RECHAZAR ] [ MODIFICAR ]
Observación: ________________
```

**Vista de trabajador — Administración** (sin acciones de horas extra, coherente con `overtime_eligible = false`; sí con justificación de atraso y `payroll_effect`):

```
MARÍA PÉREZ — ADMINISTRACIÓN
Entrada: 07:42   Atraso: 12 min
Salida: 18:25    Horas extra elegibles: 0

[ JUSTIFICAR ATRASO ] [ APLICAR ]
```

Estos mockups conceptuales son insumo directo para el diseño de pantallas de Fase 6, y confirman que el modelo de datos (sección 18) debe exponer `overtime_eligible` de forma consultable por UI para decidir qué botones mostrar — no es solo una regla de cálculo interno, también es un requisito de presentación.

---

## 24. Casos de test obligatorios (documentados para implementarse en Fase 12, no ahora)

**Producción, lunes-jueves (fórmula de la sección 6):**

```
17:00 →   0 min      18:30 →  90 min      19:45 → 120 min
17:30 →  30 min      19:00 → 120 min      22:00 → 120 min
18:00 →  60 min      19:01 → 120 min
```

**Administración (elegibilidad, sección 5) — nunca genera horas extra sin importar la hora de salida:**

```
17:00 → 0     18:00 → 0     19:30 → 0     22:00 → 0
```

**Atrasos, con `tolerance = 0` (sección 11):**

```
07:15 →  0    07:29 →  0    07:30 →  0
07:31 →  1    07:45 → 15    08:00 → 30
```

**Aprobación parcial:**

```
candidate = 120 → approved = 90 → rejected = 30 (persistido, sección 10)
```

**Tope de horas extra (clock-out muy tardío, sección 7):**

```
clock_out real = 20:30 (conservado tal cual en AttendanceRecord)
candidate_overtime_minutes = 120 (tope aplicado, no 210)
```

**Conflicto de sincronización (sección 19, sin cambios respecto a v1, reafirmado con el ejemplo exacto del encargo):**

```
08:00 → Workera informa candidate = 120
09:00 → Supervisor aprueba approved = 120
14:00 → Workera cambia el dato subyacente → nuevo candidate = 90
Resultado esperado: SYNC_CONFLICT, la aprobación de 120 NO se sobrescribe ni se recalcula sola
```

---

## 25. Excel Export — validación de la arquitectura y de `.xls`/`.xlsx`

**Arquitectura de generación (sin cambios respecto a la v1, reafirmada):**

```
Workera → Datos sincronizados → Cálculos (OvertimePolicy/LateArrivalPolicy)
        → Decisiones de supervisor → Validaciones (sección 20)
        → WeeklyReview CLOSED → Snapshot → ExcelExport
```

Confirmado que sigue siendo correcta: las reglas nuevas de esta versión (políticas de cálculo) se insertan en el paso "Cálculos", sin alterar el resto del flujo ya validado en la v1.

**Campos mínimos de auditoría del export** (sin cambios): `weekly_export_id`, `period_start`, `period_end`, `generated_at`, `generated_by`, `template_version`, `validation_status`, `file_hash`, más `snapshot_id` (ya evaluado como necesario en la v1) para poder responder "¿qué información exacta produjo este Excel?".

**`.xls` vs `.xlsx` — se valida que la recomendación anterior sigue siendo correcta, sin cambios:**

```
Conservar .xls original (sin tocar)
        ↓
Copia maestra .xlsx creada manualmente en Excel (Guardar como), no por script
        ↓
Esa copia .xlsx es la plantilla versionada (template_version)
        ↓
ExcelJS genera los archivos futuros a partir de esa plantilla
```

No se realiza ninguna conversión en esta tarea.

---

## 26. Viáticos — reafirmado sin cambios

`OUT_OF_SCOPE_PENDING_CONFIRMATION`, sin entidad propia. El patrón hecho→cálculo→decisión→resultado sigue siendo suficientemente genérico para incorporar un futuro `PerDiemRecord` sin rediseñar `Employee`, `DailyReview` ni el resto del modelo, tal como se concluyó en la v1.

---

## 27. Impacto sobre Fase 2 y recomendación final

**Impacto:** esta versión agrega a la especificación de Fase 2 tres piezas estructurales que no estaban explícitas en la v1: `EmployeeGroup` (y su rol como llave de las políticas), `WorkSchedule`/`ScheduleAssignment` con vigencia temporal, y `OvertimePolicy`/`LateArrivalPolicy` como tablas de configuración explícitas en vez de lógica de aplicación. Ninguna de estas piezas contradice el modelo de `OvertimeRecord`/`OvertimeDecision`/`LateArrivalRecord`/`LateArrivalDecision` ya cerrado en la v1 — lo alimentan con las fórmulas y el origen de sus valores calculados.

**Recomendación explícita:**

```
READY_FOR_PHASE_2
```

**Justificación:** las preguntas P0 pendientes (reglas exactas de HH 50%/100%, regla de viernes, autoridad de aprobación/descuento, ciclo real del Excel) no bloquean **la estructura** de las tablas, porque el diseño de esta especificación las trata explícitamente como **datos de política configurables** (`OvertimePolicy.rate_type_rule`, `OvertimePolicy` con `day_of_week`, roles ya contemplados en `profiles`/RLS de Fase 3), no como supuestos hardcodeados en el esquema. Fase 2 puede construir las tablas y dejar sembrados los valores conocidos con certeza hoy (horario real lunes-jueves, tope de 120 min, tolerancia 0), dejando explícitamente vacíos o marcados como pendientes los valores que dependen de las respuestas P0 (regla de viernes, regla de tasa 50/100), sin que eso obligue a una migración posterior — son filas de política nuevas o editadas, no cambios de columna.

Esto no es una autorización para avanzar — **queda expresamente detenido a la espera de tu aprobación**, tal como se pidió.
