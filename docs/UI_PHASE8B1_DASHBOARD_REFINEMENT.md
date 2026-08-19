# Fase 8B.1 — Refinamiento visual/UX del dashboard operacional

Refina el dashboard construido en Fase 8, sin tocar backend/reglas de negocio/RLS/roles.
Todo lo nuevo en esta fase sigue el mismo principio arquitectónico de Fase 8: la UI presenta
información y captura decisiones, nunca recalcula reglas.

## Arquitectura visual

Paleta ARCOTEX (`src/app/globals.css`): sidebar/topbar azul marino (`--color-arcotex-navy` /
`--color-arcotex-navy-dark`), azul corporativo del logo (`--color-arcotex-blue`) para acentos y
links, fondo claro (`--color-background`), cards blancas (`--color-card`) con bordes suaves
(`--color-border`) y sombra discreta, colores semánticos fijos (warning/critical/success/info) —
deliberadamente sin `prefers-color-scheme` automático: es una app empresarial con marca fija, no
un sitio con modo oscuro opcional.

Logo (`src/components/shell/ArcotexLogo.tsx`): recreación vectorial SVG inline de las dos líneas
curvas del logo real, adaptada a `currentColor` (blanco sobre el navy del sidebar) para mantener
contraste — nunca un archivo raster.

## Componentes creados

- `src/components/shell/ArcotexLogo.tsx` — marca vectorial.
- `src/components/dashboard/KpiRow.tsx` — fila de 6 KPIs compacta.
- `src/components/dashboard/PriorityQueueCard.tsx` — categorías de pendientes.
- `src/components/dashboard/ReviewQueueCard.tsx` — personas concretas que requieren revisión.
- `src/components/dashboard/UpcomingEventsCard.tsx` — cumpleaños del mes + próximo feriado.
- `src/components/dashboard/WeekSummaryCard.tsx` — resumen semanal.
- `src/components/dashboard/ExcelExportCard.tsx` — UI preparada, deshabilitada.

## Componentes reutilizados (sin reescribir)

- `Sidebar.tsx`/`Topbar.tsx` (Fase 8) — restilizados (colores, estructura de secciones,
  bloque de usuario/área, footer de período) pero conservan exactamente el mismo contrato de
  seguridad: `AppLayout` sigue siendo el único punto que resuelve rol real y redirige sin sesión.
- `WorkeraSyncStatus.tsx` — mismo componente, solo recoloreado con la paleta nueva.
- `StateMessages.tsx`, `ComingSoon.tsx` — sin cambios.
- `getDailyReview` (Fase 7), `resolveEffectiveSchedule`/`resolveTimeControlPolicy` (Fase 7),
  `getWorkeraSyncHealth` (Fase 6B) — reutilizados sin modificar una sola línea.

## Server/client boundaries

Sin cambios respecto a Fase 8: todo el nuevo `dashboard-view.ts` es `"server-only"`, las páginas
son Server Components, el único Client Component nuevo es implícito (`Sidebar.tsx` ya era
`"use client"` desde Fase 8, solo por el toggle de colapsar/expandir — sigue sin tocar datos ni
secretos).

## Sidebar

- **Role-aware**: `getNavSectionsForRole` (`nav-config.ts`, reescrito) agrupa en secciones con
  encabezado opcional. Supervisor gana "Mi Equipo" -> `/empleados` (el roster YA estaba scopeado
  por área desde Fase 8, `employees-view.ts` — solo faltaba enlazarlo en su navegación).
- **Colaciones / Nómina de Pago / Rendiciones**: `comingSoon: true`, `href: ""` — el Sidebar los
  renderiza como `<div>` no navegable con badge "Próximamente", nunca como `<Link>`. Cero tablas,
  cero migraciones, cero servicios nuevos para estos tres módulos (verificado: ningún archivo de
  este commit menciona colación/nómina/rendición fuera de esta etiqueta visual).
- **Reportes / Historial de Decisiones**: mismo tratamiento `comingSoon` — no existe un servicio
  backend agregado para ninguno de los dos (verificado por auditoría antes de empezar), así que
  se documentan como pendientes en vez de construir una página falsa.
- **Semana actual / Período actual**: footer del sidebar, real (`getPeriodStatus`, nuevo,
  consulta `weekly_reviews`/`reporting_periods` por la fila que contiene la fecha de hoy). Ambas
  tablas existen con RLS completa desde fases anteriores pero **están vacías** en este entorno
  (nunca se creó una fila) — el footer muestra honestamente "Sin período configurado" en vez de
  inventar "11–17 Ago 2026 ABIERTA" como en el mockup ilustrativo del encargo.

## KPI row

Reemplaza la tabla grande de "Marcaciones del día" que el encargo pedía eliminar —
**verificado que nunca llegó a construirse en Fase 8** (grep sin resultados), así que no había
nada que remover del código, solo se construyó directamente la fila de KPIs.

Las 6 métricas y su fuente real:

| KPI | Fuente |
|---|---|
| Trabajadores (presentes / activos) | `attendance_records.actual_clock_in` no nulo hoy / `employees.active` |
| Atrasos por justificar | `late_arrival_records` sin `late_arrival_decisions` vigente |
| Horas extra por aprobar | `overtime_records` sin `overtime_decisions` vigente |
| Clock out pendientes | `attendance_missing_punch_flags` (`PENDING_CONTACT`/`CONTACTED`) |
| Ausencias registradas hoy | `absence_records` vigentes que cubren la fecha |
| Pendientes de cerrar | suma de `requiresReview` de `getDailyReview` (todas las categorías) |

Todas las consultas están scopeadas por área (`getScopedEmployeeIds`, nuevo) — un supervisor
nunca ve un número que incluya otra área.

## Priority queue

Las 5 categorías (`PASO 5`) son un mapeo 1:1 de las categorías que **ya calcula** `getDailyReview`
(Fase 7), agregado en `buildPriorityAndReviewQueue` (nuevo): `LATE`→Atrasos,
`OVERTIME_CANDIDATE`→Horas extra, `MISSING_PUNCH`→Clock out, `ABSENCE`→Licencias por validar,
`LICENSE_DOCUMENT_REQUIRED`+`MEDICAL_DOCUMENT_REQUIRED`→Documentos pendientes. Cero recálculo.
Cada card navega a `/revision-diaria` con el filtro real correspondiente (se agregaron los
filtros `clock-out` y `documentos` a la página de revisión diaria, que antes no existían —
`filtro=documentos` ya se referenciaba desde el sidebar de Fase 8 pero no tenía un caso real en
`matchesFilter`, bug latente corregido de paso).

## Review queue

Personas concretas (no conteos), tomadas directamente de `review.requiresReview` de
`getDailyReview`. Cuando una persona tiene varias categorías simultáneas, se elige UNA prioritaria
(orden: atraso > horas extra > clock out > licencia > documento) para la fila — evita duplicar la
misma persona varias veces. Los minutos mostrados (`12 min`, `150 min`) vienen de una consulta
real por lote a `late_arrival_records`/`overtime_records` (nunca recalculados, solo leídos).
Cada fila navega a `/revision-diaria?...&empleado=<id>`, el mismo detalle real construido en Fase 8.

## Upcoming events

- **Cumpleaños del mes**: `employee_birthdays` (Pre-Fase-8: 31/44 resueltos, sin cambios en esta
  fase — no se tocó el pipeline de reconciliación). Scopeado por área para supervisores. "HOY" se
  destaca visualmente cuando `birth_day` coincide con el día actual — puramente informativo,
  nunca decide si el trabajador puede salir a las 12:00 (esa decisión sigue en
  `generateEarlyDepartureCandidate`, Fase 7, que ni siquiera crea un registro cuando corresponde
  autorización por cumpleaños).
- **Próximo feriado**: `holidays` (tabla real con RLS desde una fase anterior) — **0 filas** en
  este entorno (nunca se cargó ningún feriado). La consulta es real
  (`holiday_date >= hoy ORDER BY holiday_date LIMIT 1`); cuando no hay resultado, se muestra
  "Sin feriados registrados — fuente de feriados pendiente de carga" en vez de inventar una
  fecha. No se hardcodeó ningún calendario chileno.

## Week summary

| Métrica | Disponible | Fuente |
|---|---|---|
| Atrasos / Minutos de atraso | Sí | `late_arrival_records`, semana actual (lunes–domingo) |
| Horas extra aprobadas | Sí | `overtime_decisions` (`FULLY_APPROVED`/`PARTIALLY_APPROVED`) |
| Ausencias | Sí | `absence_records` vigentes que solapan la semana |
| Bonos generados | Sí | `employee_daily_bonuses` |
| **Asistencia promedio** | **No** | Requeriría iterar cada empleado × cada día × `resolveEffectiveSchedule` para saber "se esperaba que marcara" -- no existe un servicio de agregación confiable todavía. Se muestra explícitamente "No disponible aún", nunca un número aproximado. |

## Excel

- UI implementada: sí (card completa, botones de rango, explicación).
- Backend disponible: **NO** — `excel_exports` es una tabla desde una fase anterior sin ningún
  servicio que genere un archivo real (verificado: cero referencias en `src/lib`).
- Export real ejecutado: **NO** — el botón está `disabled`/`aria-disabled`, badge "Próximamente"
  visible, ningún Excel falso se genera en runtime.

## Workera status

Mismo componente de Fase 8 (`WorkeraSyncStatus`), solo recoloreado. Sigue sin mostrar
`API_USER`/`API_KEY`/payload crudo/RUT — solo el estado normalizado + fecha ya formateada de
`getWorkeraSyncHealth`. Visible únicamente en el dashboard de SUPER_ADMIN/ADMIN_RRHH.

## Responsive

- **Desktop (≥1440px)**: layout de referencia — fila de KPIs, 3 columnas (prioritarios/revisión/
  eventos), segunda fila de 3 columnas (semana/excel/sync).
- **Tablet (768px)**: verificado sin overflow horizontal (`scrollWidth === clientWidth`) — el
  grid de KPIs baja a `sm:grid-cols-3`, las columnas de 3 colapsan según `lg:grid-cols-3`.
- **Mobile (375px)**: **bug real encontrado y corregido en esta fase** — el Sidebar por defecto
  se abría expandido (`w-64`, 256px) incluso en mobile, causando overflow horizontal de página
  completa (`scrollWidth` 410px vs `clientWidth` 375px). Corregido: por debajo del breakpoint
  `md` (768px) el sidebar SIEMPRE queda en modo icono (`w-16`, 64px) sin importar el estado del
  toggle manual — el toggle solo tiene efecto real desde `md:` hacia arriba. Verificado de nuevo
  tras el fix: `scrollWidth === clientWidth` en los tres breakpoints.

## Accesibilidad

Sin regresiones respecto a Fase 8: HTML semántico (`<nav>`, `<section aria-labelledby>`,
`role="status"`/`role="alert"`), foco visible en todos los controles nuevos, badges con texto
explícito además de color/ícono (ej. "⚠ Atraso", nunca solo un punto de color), botones
deshabilitados marcados con `aria-disabled`.

## Verificación por roles (manual, navegador real)

- **SUPER_ADMIN**: navegación completa (incluye Usuarios/Configuración), dashboard admin con
  las 3 áreas, footer de período "Sin período configurado" (real, tablas vacías).
- **ADMIN_RRHH**: mismo dashboard que SUPER_ADMIN, sin Usuarios/Configuración en el sidebar.
- **SUPERVISOR_PRODUCTION**: sidebar reducido con "Mi Equipo"/chip de área "Producción",
  dashboard scopeado. `/revision-diaria?area=INSTALLATION` por URL directa -> "No tienes acceso
  a esta área" (bloqueado server-side).
- **SUPERVISOR_INSTALLATION**: mismo comportamiento, `/revision-diaria?area=PRODUCTION` por URL
  directa también bloqueado.

## Tests

- `nav-config.test.ts` (ampliado): +4 tests nuevos, incluye verificación explícita de que ningún
  item navegable tiene `href` vacío y que los módulos futuros están correctamente marcados
  `comingSoon`.
- `dashboard-view.test.ts` (nuevo): helpers puros (`categoryToReviewQueueCategory`, `initialsOf`,
  `currentWeekRange`) + **una prueba de regresión directa** para el bug real de scoping
  encontrado en esta misma fase (`getSupervisorDashboard` pasaba `null`/sin-scope al resumen
  semanal y a cumpleaños en vez de la lista de empleados de su área — corregido antes de
  cualquier verificación manual, cubierto ahora por test para que no vuelva a ocurrir).

## Seguridad

- `.env.local`: no trackeado (confirmado, `.gitignore` lo cubre).
- Grep dedicado: sin `WORKERA_API_KEY`/`WORKERA_API_USER`/`SUPABASE_SERVICE_ROLE_KEY`/
  `CRON_SECRET` fuera de archivos `server-only` ya existentes: sin resultados nuevos.
- Sin `NEXT_PUBLIC_WORKERA_*` (cubierto además por el test dedicado ya existente,
  `workera/security.test.ts`).
- Sin RUT ni payload crudo de Workera en ningún componente/view-model nuevo.
- Cross-area: verificado manualmente (ver "Verificación por roles").
