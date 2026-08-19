# Fase 8 — Layout / UI operacional

Primera versión real del shell + pantallas operacionales, construida sobre el backend ya
validado (Fase 6A/6B/7/Pre-Fase-8) sin reescribir ninguna regla de negocio existente.

## Arquitectura

```
WORKERA -> workera_attendance_events (Fase 6A/6B)
        -> business-rules/* (Fase 7: schedule, late-arrival, early-departure,
           overtime-confirmation, birthday, daily-review)
        -> view-models/* (Fase 8, NUEVO: adapta backend -> DTOs de UI,
           nunca recalcula una regla)
        -> decisions/* (Fase 8, NUEVO: escribe decisiones del supervisor,
           usa SIEMPRE el cliente de sesión -- RLS sigue siendo el
           enforcement real)
        -> app/(app)/**/page.tsx (Server Components, consumen view-models)
```

- **App shell**: `src/app/(app)/layout.tsx` -- obtiene el `profile` real
  (`getCurrentProfile`, Fase 3), redirige a `/login` si no hay sesión o rol
  activo, y renderiza `Sidebar`/`Topbar` (`src/components/shell/`) con
  navegación role-aware (`nav-config.ts`, datos puros, sin lógica de
  negocio).
- **Server/client boundary**: toda lectura/escritura real ocurre en Server
  Components o Server Actions (`"use server"`), usando el cliente de sesión
  (`@/lib/supabase/server`) -- nunca el cliente admin desde una ruta
  alcanzable por un usuario no privilegiado. La única excepción es
  `getAdminDashboard` (usa `getWorkeraSyncHealth`, que internamente usa el
  cliente admin) -- solo se invoca para `SUPER_ADMIN`/`ADMIN_RRHH`, nunca
  para un supervisor. El único componente cliente (`"use client"`) es
  `Sidebar.tsx`, y solo por el estado de colapsar/expandir -- no toca datos
  ni secretos.
- **DTO/view-model layer**: `src/lib/view-models/*.ts` -- cada uno envuelve
  un servicio de Fase 7 ya existente (`getDailyReview`, `resolveEffectiveSchedule`,
  `resolveTimeControlPolicy`, `getWorkeraSyncHealth`) y agrega SOLO lo que la
  UI necesita presentar, nunca recalcula una regla. Ningún componente React
  depende del shape crudo de una tabla de Supabase.

## Roles

- **SUPER_ADMIN**: navegación completa (incluye Usuarios/Configuración,
  stubs "Próximamente" -- no había servicio de escritura pendiente para
  construir en esta fase salvo Usuarios, que si tiene backend real desde
  Fase 5D pero quedó fuera de alcance de tiempo de esta fase).
  Dashboard admin: contadores reales del día + atención requerida + actividad
  por área + estado de sync Workera.
- **ADMIN_RRHH**: mismo dashboard/Revisión diaria/Empleados que SUPER_ADMIN,
  sin Usuarios/Configuración.
- **SUPERVISOR_PRODUCTION** / **SUPERVISOR_INSTALLATION**: navegación
  reducida ("Mi equipo" en vez de "Dashboard"), dashboard de solo su área
  (contadores de revisión pendiente), Revisión diaria fijada a su área --
  el selector de área ni siquiera se renderiza para ellos.

## Navegación

- **Role-aware**: `getNavItemsForRole` (`nav-config.ts`) decide qué se
  OFRECE en el menú -- test cubierto en `nav-config.test.ts`, incluye una
  prueba específica de "hrefs únicos por rol" (atrapó un bug real de esta
  misma fase: dos entradas de menú apuntaban al mismo href y React lanzaba
  "duplicate key").
- **Server enforced**: cada página server-side vuelve a resolver el rol real
  (`getCurrentProfile`) y, para páginas con datos de un área específica,
  aplica `assertAreaAccessAllowed`/`assertEmployeeAccessAllowed`
  (`src/lib/access/scope.ts`, NUEVO en esta fase) -- verificado manualmente:
  un supervisor de Producción autenticado que visita
  `/revision-diaria?area=INSTALLATION` directamente por URL recibe "No
  tienes acceso a esta área", nunca los datos. Las páginas de solo
  SUPER_ADMIN (`/usuarios`, `/configuracion`) y solo
  SUPER_ADMIN+ADMIN_RRHH (`/periodos`, `/exportaciones`) redirigen a
  `/dashboard` para cualquier otro rol.
- **Responsive**: sidebar colapsable (icono/toggle), topbar simple, grid de
  tarjetas y layout de dos columnas en Revisión diaria colapsan a una sola
  columna en pantallas angostas (Tailwind `lg:grid-cols-[...]`).

## Dashboard

- **SUPER_ADMIN/RRHH**: presentes/atrasos/ausencias/OT pendientes (conteos
  reales del día, America/Santiago), sección "Atención requerida" (licencias
  sin documento, comprobantes médicos pendientes, OT/atrasos sin decisión),
  actividad por área (reutiliza `getDailyReview` tres veces, una por área),
  `WorkeraSyncStatus`.
- **Supervisores**: solo "Requieren revisión" / "Sin novedades" de su área,
  sin métricas de otras áreas ni acceso a `getWorkeraSyncHealth`.
- Ninguna métrica se inventó: todo conteo sale de una tabla o servicio real
  ya construido en fases anteriores.

## Revisión diaria

- Backend real conectado: `getDailyReviewBoard`/`getDailyReviewDetail`
  (`daily-review-view.ts`) envuelven `getDailyReview` (Fase 7) sin
  modificarlo.
- Navegación de fecha (‹/›, America/Santiago vía `date-utils.ts`, separado
  deliberadamente de `sync/target-date.ts` que resuelve D-1 para el pipeline
  de sync -- un concepto distinto).
- Selector de área solo se muestra si el rol puede ver más de una
  (`areasVisibleToRole`).
- Filtros: Todos/Pendientes/Revisados/Atrasos/Salida anticipada/Horas
  extra/Ausencias -- "Revisados" es una simplificación documentada: el
  modelo de datos actual no distingue "sin novedades desde siempre" de
  "novedades ya resueltas", ambos caen en `noIssues` de `getDailyReview`.
- Tarjeta de empleado: nombre, área, entrada/salida, badges de categoría,
  estado REQUIERE REVISIÓN/OK -- nunca RUT/dirección/teléfono/email.
- Detalle (panel lateral, no modal): horario efectivo real
  (`resolveEffectiveSchedule`), control horario (`resolveTimeControlPolicy`),
  atraso/OT/salida anticipada/ausencia con sus decisiones ya tomadas o
  botones para tomarlas, cumpleaños informativo (`employee_birthdays`, solo
  muestra si es su cumpleaños hoy -- nunca recalcula el umbral de las
  12:00, esa decisión ya la tomó `generateEarlyDepartureCandidate` al no
  crear un registro).

## Presentación de reglas de negocio

- **Atraso**: `Justificar`/`No justificar` -> `decideLateArrival`
  (`src/lib/decisions/late-arrival-decisions.ts`, NUEVO). Mapeo
  determinista: justificado = `payroll_minutes=0`,
  `payroll_effect=DO_NOT_DEDUCT`; no justificado = descuenta los minutos
  detectados completos, `DEDUCT`. Es el único mapeo consistente con el
  significado de esas columnas (Fase 7 nunca construyó este servicio de
  escritura, solo el esquema + el motor de generación de candidatos).
- **Atraso acumulado semanal**: NO implementado -- no existe todavía un
  servicio backend que agregue atrasos por semana (`weekly_reviews`/
  `weekly_review_snapshots` existen desde Fase 2 pero ningún código los
  puebla); sumar manualmente en React habría violado el principio
  arquitectónico de la fase, así que se dejó fuera y documentado aquí como
  pendiente en vez de inventarlo.
- **Horas extra**: `Aprobar`/`Rechazar` -> `decideOvertime`
  (`overtime-decisions.ts`, NUEVO), solo aprobación/rechazo completo (no
  parcial, no lo pedía el encargo). El bono (`employee_daily_bonuses`) se
  muestra tal cual lo calculó el trigger `overtime_decisions_recompute_bonus`
  (Fase 7/anterior) -- nunca calculado en el cliente.
- **Licencia**: flujo Sí/No -> `markAbsencePendingDocument`/`disputeAbsence`
  (`absence-decisions.ts`, NUEVO); "Sí" exige documento antes de poder
  `confirmAbsenceDocument` (el trigger real `validate_absence_decision_document`,
  Fase 7, rechaza el cierre sin documento adjunto -- este servicio no
  duplica esa validación).
- **Salida médica**: `markEarlyDepartureMedical` deja el caso `NEEDS_REVIEW`
  con plazo de 3 días hábiles (`addBusinessDays`, Fase 7, reutilizado sin
  cambios); `confirmEarlyDepartureMedicalDocument` intenta cerrar
  `DO_NOT_DEDUCT` y el trigger real rechaza si no hay documento.
- **Cumpleaños**: nunca se pregunta por comprobante médico ni se trata como
  salida irregular -- el motor (`generateEarlyDepartureCandidate`, Fase 7)
  ni siquiera crea un registro cuando la salida está autorizada por
  cumpleaños, así que no hay nada que decidir manualmente; el badge 🎂 es
  puramente informativo (`employee_birthdays`, comparación de fecha, sin
  recalcular el umbral de las 12:00).
- **Horarios personalizados**: la UI solo presenta `resolveEffectiveSchedule`
  (Fase 7) -- ningún nombre de empleado está hardcodeado en ningún
  componente ni view-model de esta fase.
- **Exentos**: `resolveTimeControlPolicy` (Fase 7) determina EXENTO/NORMAL;
  la UI nunca decide por nombre. Claudio/Michel siguen
  `MANUAL_REVIEW_REQUIRED` (Pre-Fase-8) -- no se les inventó ninguna
  política en esta fase.

## Documentos

- **Upload UX**: formulario nativo (`<input type="file">` + Server Action
  `uploadDocumentAction`) dentro del panel de detalle, para licencia
  (`ABSENCE`) y comprobante médico (`EARLY_DEPARTURE`).
- **Requisito de documento**: comunicado explícitamente en la UI
  ("DOCUMENTO DE RESPALDO OBLIGATORIO", plazo visible) antes de permitir
  intentar `Confirmar documento recibido` -- el enforcement real sigue
  siendo el trigger de base de datos (Fase 7), la UI solo lo comunica.
- **Seguridad de Storage**: bucket privado `supporting-documents` CREADO en
  esta fase (`supabase/migrations/20260821100000_phase8_documents_storage_bucket.sql`)
  -- Fase 7 había dejado esto explícitamente pendiente
  ("Storage real no implementado"). Políticas RLS de `storage.objects`
  replican EXACTAMENTE el criterio ya usado por `supporting_documents`
  (Fase 7): INSERT solo si `can_manage_employee(employee_id)` (primer
  segmento de la ruta), SELECT/descarga solo `is_privileged_admin()` -- un
  supervisor puede adjuntar pero no descargar/listar documentos ya subidos,
  ni siquiera los que él mismo subió (mismo límite que ya tenía la tabla de
  metadata, no es una restricción nueva). **Limitación conocida**: si el
  INSERT de metadata falla después de una subida exitosa a Storage, el
  archivo queda huérfano (sin fila que lo referencie) -- no hay
  garbage-collection todavía, documentado para una fase posterior.

## Empleados

- Roster real (`getEmployeeRoster`, `employees-view.ts`) con filtro de área
  y búsqueda por nombre.
- Scoping de área: supervisor ve solo su área (incluye la exclusión
  explícita de empleados sin `employee_group_id`, ej. la mayoría del roster
  recién bootstrapeado en Pre-Fase-8 que no tiene área asignada todavía);
  RRHH/SUPER_ADMIN ven todo, incluidos los sin área.
- PII: NUNCA se lee ni se muestra `rut` -- verificado con un test dedicado
  (`employees-view.test.ts`, "nunca expone el campo RUT en la vista, aunque
  exista en la fila real").

## Estado de sincronización Workera

- `WorkeraSyncStatus` (componente) + `getWorkeraSyncHealth` (Fase 6B,
  reutilizado sin cambios) -- solo en el dashboard de SUPER_ADMIN/RRHH.
  Nunca se le pasa `error_summary` crudo ni ningún detalle interno; solo el
  estado normalizado (HEALTHY/STALE/RUNNING/DEGRADED/UNKNOWN) y fechas ya
  formateadas. Los supervisores no ven este componente en absoluto (el
  encargo permitía omitirlo si no aporta valor -- se decidió omitir en vez
  de mostrar una versión reducida sin justificación clara de qué agregaría).

## Responsive

- **Desktop**: layout de referencia (sidebar + topbar + contenido), grid de
  varias columnas en dashboard/revisión.
- **Tablet**: el grid de estadísticas y el grid de revisión diaria
  (`lg:grid-cols-[...]`) colapsan naturalmente por breakpoints de Tailwind;
  no se probó en un dispositivo físico, solo verificado por breakpoints.
- **Móvil**: mismas páginas priorizadas (revisión diaria, detalle,
  documentos, equipo) siguen siendo la única navegación -- no hay una vista
  "solo escritorio" bloqueada. La tabla de empleados usa `overflow-x-auto`
  en su contenedor (nunca la página completa) para no romper el layout en
  pantallas angostas.

## Accesibilidad

- HTML semántico: `<nav>`, `<main>`, `<header>`, `<table>` con `<th scope="col">`,
  `role="tablist"/"tab"` en el selector de área, `role="alert"`/`role="status"`
  en estados de error/vacío.
- Navegación por teclado: todos los controles son `<a>`/`<button>`/`<input>`
  reales (nunca un `<div onClick>`), con `focus-visible:outline` explícito
  en los estilos.
- Labels: inputs de búsqueda tienen `<label>` (visualmente oculto con
  `sr-only` cuando el placeholder ya es suficientemente descriptivo),
  botones de paginación de fecha tienen `aria-label`.
- Los estados nunca dependen solo del color: cada badge/alerta lleva
  también un ícono textual (⚠/✓/🎂) y texto explícito ("REQUIERE REVISIÓN",
  "Atraso 12 min").

## Seguridad (verificado)

- `WORKERA_API_KEY`/`SUPABASE_SERVICE_ROLE_KEY`/`CRON_SECRET`: nunca en un
  archivo sin `import "server-only"`, nunca en un componente `"use client"`
  (grep dedicado, sin resultados).
- RUT: nunca leído ni renderizado por ningún view-model/componente nuevo de
  esta fase (grep + test dedicado).
- Payload crudo de Workera: nunca expuesto -- todos los datos pasan por
  `getEmployeeRoster`/`getAttendanceEvents` (Fase Pre-8) que ya minimizan
  antes de llegar a cualquier código de Fase 8.
- Cross-area: verificado manualmente en navegador -- un supervisor de
  Producción autenticado no puede ver Instalación ni por navegación normal
  (no aparece en su UI) ni manipulando la URL directamente
  (`assertAreaAccessAllowed` lo rechaza server-side, cubierto también por
  `scope.test.ts`).
- Storage/signup: bucket privado (`public: false`, verificado por consulta
  directa a `storage.buckets`), sin URLs públicas generadas en ningún punto
  del código; no se agregó ningún flujo de registro público.

## Limitaciones conocidas (para una fase de UI posterior)

- `/usuarios`, `/configuracion`, `/periodos`, `/exportaciones`: solo stubs
  "Próximamente" con el guard de rol correcto server-side -- sin
  funcionalidad real todavía (Usuarios sí tiene backend completo desde Fase
  5D, `src/lib/admin/user-management.ts`, pero construir su UI quedó fuera
  del alcance de tiempo de esta fase).
- No existe una suite de tests de renderizado de componentes React
  (Vitest/Testing Library) -- se evaluó deliberadamente y se decidió NO
  agregar una dependencia nueva grande en esta fase ("antes de instalar una
  dependencia: comprobar si realmente hace falta") sin que el encargo lo
  pidiera explícitamente; en su lugar, toda la lógica de negocio/seguridad
  de la UI (scoping de área, mapeo de decisiones, shape de los
  view-models, nunca-RUT) está cubierta por tests `node:test` reales contra
  la lógica pura/los servicios, más verificación manual en navegador real
  (login de los 4 roles, navegación, scoping cross-área, dashboard/revisión
  diaria con datos reales). El renderizado visual en sí (JSX/Tailwind) no
  tiene cobertura automatizada.
- Atraso acumulado semanal: sin servicio backend, sin UI (ver sección
  "Atraso" arriba).
- Aprobación PARCIAL de horas extra: no implementada (el encargo solo pedía
  Aprobar/Rechazar).
- Garbage-collection de archivos huérfanos en Storage: no implementada (ver
  sección "Documentos").
