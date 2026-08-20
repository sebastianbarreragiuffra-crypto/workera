# Auditoría UX/flujos — Workera Supervisor App (para Codex)

**Generado:** 2026-08-20, sobre commit `4c2dda4` (branch `master`) + 3 archivos con cambios sin commitear (`src/app/login/page.tsx`, `src/components/shell/ArcotexLogo.tsx`, `src/components/shell/Sidebar.tsx`).

**Propósito de este documento:** dar a Codex (u otro agente) un punto de partida preciso y priorizado para mejorar los flujos de la app, sin que tenga que redescubrir el estado actual desde cero. Es un documento de **hallazgos + dirección recomendada**, no una especificación de código exacta — las decisiones de implementación quedan a criterio de quien lo ejecute.

---

## 0. Contexto obligatorio antes de tocar código

Este proyecto tiene reglas de arquitectura estrictas que **ya se respetaron** en todas las fases anteriores y deben seguir respetándose:

- **Server-first**: Server Components + Server Actions + Supabase con RLS. No mover lógica de negocio (cálculo de atrasos, horas extra, cumpleaños, bonos) al cliente/React.
- **Nunca recalcular reglas de negocio** que ya calcula el backend (`src/lib/business-rules/*`, Fase 7). La UI solo presenta y captura decisiones.
- **RLS sigue siendo la autoridad real**, nunca solo un filtro visual. El scoping por área (`SUPERVISOR_PRODUCTION` solo ve `PRODUCTION`, etc.) ya está resuelto en `src/lib/access/scope.ts` y en los view-models — reusar, no reimplementar.
- **No inventar datos.** Si un widget no tiene backend confiable (ver §2 "Asistencia promedio", feriados, Excel export), debe seguir mostrando su estado "no disponible/próximamente" honesto — no rellenarlo con números de ejemplo.
- **No tocar**: `workera_attendance_events` (ingesta cruda de Workera), el pipeline de sync (Fase 6A/6B), ni las tablas/triggers de Fase 7.
- Antes de cualquier cambio: `git status` limpio, trabajar sobre un commit conocido, no hacer `reset`/`checkout --`/`stash` destructivo sin confirmar primero.

Este documento es sobre **UX y consistencia de código**, no sobre seguridad (que ya se auditó en fases previas) — pero cualquier cambio debe preservar el modelo de permisos existente.

---

## 1. Resumen del estado actual

| Pantalla | Ruta | Madurez |
|---|---|---|
| Login | `/login` | Completa, en rediseño activo (sin commitear) |
| Dashboard | `/dashboard` | Completa, la más pulida |
| Revisión Diaria | `/revision-diaria` | Completa pero es la pantalla más usada y con más fricción (ver §3) |
| Roster de empleados | `/empleados` | Completa |
| Ficha de empleado | `/empleados/[id]` | Completa (nueva, Fase 8C) |
| Centro de documentos | `/documentos` | Completa (nueva, Fase 8C) — **pero con un problema de flujo real, ver §4** |
| Usuarios | `/usuarios` | **Stub** — backend completo (`src/lib/admin/user-management.ts`) sin UI |
| Configuración | `/configuracion` | Stub |
| Períodos | `/periodos` | Stub |
| Exportaciones | `/exportaciones` | Stub (backend de Excel tampoco existe) |

Roles: `SUPER_ADMIN`, `ADMIN_RRHH`, `SUPERVISOR_PRODUCTION`, `SUPERVISOR_INSTALLATION`. El concepto "APP_ADMIN" mencionado en el último commit **no es un rol nuevo en la base de datos** — es una etiqueta conceptual que en código sigue siendo `SUPER_ADMIN` (`requireAppAdmin()` en `src/lib/supabase/authorize.ts` llama internamente a `requireCurrentRole("SUPER_ADMIN")`). No confundir con un rol real al planificar trabajo.

---

## 2. Hallazgos priorizados

### 🔴 Alta prioridad — impacto directo en el flujo diario del supervisor

**2.1 — `/usuarios` es un stub pese a tener backend completo**
El backend (`listAppUsers`, `createAppUser`, `assignRole`, `setUserActive`) está terminado y correctamente autorizado (`SUPER_ADMIN`-only desde el último commit). La página solo muestra `<ComingSoon>`. Esto es la brecha más grande "última milla no construida" de toda la app: hoy un SUPER_ADMIN no tiene ninguna forma de invitar/desactivar usuarios desde la interfaz.
→ **Recomendación:** construir la UI de `/usuarios` (tabla de usuarios + formulario de invitación + toggle de rol/activo) reusando `PageHeader`/`SectionCard`/`FilterBar`/`Badge` (§2.3). Es, con backend ya listo, la mejora de mayor relación esfuerzo/impacto disponible.

**2.2 — Revisión Diaria: cada cambio de filtro/fecha/área recarga la página completa**
Los filtros, la navegación de fecha (‹ Hoy ›), y los tabs de área son `<Link>` planos — cada clic es una navegación de servidor completa. Es consistente con la filosofía server-first del proyecto, pero es fricción real en la pantalla que un supervisor usa constantemente para procesar muchos casos rápido.
→ **Recomendación (respetando server-first):** usar `useRouter().push()` con `startTransition` o `<Link prefetch>` agresivo para que Next.js pre-cargue las rutas de filtro más probables; evaluar si vale la pena un Client Component delgado solo para los filtros (sin mover lógica de negocio, solo el `<Link>` activo). No es obligatorio ir a un SPA completo — el objetivo es reducir la sensación de "recarga" sin romper el patrón server-rendered.

**2.3 — El filtro pierde el caso seleccionado**
Los links de filtro en `/revision-diaria` solo llevan `fecha`/`area`/`filtro`, sin `empleado` — si un supervisor tiene un caso abierto en el panel derecho y cambia de filtro, el panel se cierra sin aviso.
→ **Recomendación:** preservar `empleado` en los links de filtro cuando el caso seleccionado siga siendo válido bajo el nuevo filtro; si no es válido, limpiarlo explícitamente (no solo por omisión).

**2.4 — Dos flujos de subida de documentos con semántica distinta y sin relación entre sí**
- El de `/revision-diaria` (dentro de `ReviewDetailPanel`) sube el documento **vinculado** a un caso específico (`relation: {kind, recordId}`) — eso es lo que destraba el estado "Documento pendiente"/"Vencido" de ESE caso.
- El de `/documentos` sube el documento **sin vínculo** a ningún caso (solo empleado + tipo).

Resultado: un documento subido por `/documentos` nunca destraba un caso pendiente en Revisión Diaria, aunque sea literalmente el mismo comprobante. Dos usuarios (o el mismo, en momentos distintos) pueden terminar subiendo el mismo documento dos veces sin que el sistema lo note.
→ **Recomendación:** en `/documentos`, cuando el empleado tenga un caso pendiente de documento ese día (mismo criterio que ya usa Revisión Diaria), ofrecer vincular la subida a ese caso (mismo `relation` que ya soporta `uploadSupportingDocument` en `src/lib/decisions/documents.ts`) en vez de crear un documento huérfano. Esto es un cambio de UX, no de backend — el soporte para `relation` ya existe.

### 🟡 Media prioridad — consistencia y mantenibilidad

**2.5 — Componentes compartidos existen pero no se usaron en las pantallas más antiguas**
Desde Fase 8C existe una librería real de componentes (`Badge`, `EmployeeAvatar`, `FilterBar`, `PageHeader`, `SearchInput`, `SectionCard` en `src/components/shell/`), consistentemente usada en `/empleados`, `/empleados/[id]` y `/documentos`. Pero `/dashboard` y `/revision-diaria` (construidas antes) siguen con implementaciones locales casi idénticas y ligeramente divergentes:
  - `revision-diaria/StatusBadge.tsx` duplica el sistema de tonos de `Badge.tsx`.
  - `CaseCard.tsx` reimplementa su propio avatar de iniciales en vez de usar `EmployeeAvatar`.
  - `ReviewDetailPanel.tsx` define su propio `Section()` local, muy parecido a `SectionCard`.
  - Los filtros y el buscador de `/revision-diaria` duplican markup de `FilterBar`/`SearchInput` en vez de reusarlos.
  - `/dashboard` y `/revision-diaria` no usan `PageHeader` para su encabezado.

→ **Recomendación:** retrofit — reemplazar las implementaciones locales por los componentes compartidos donde el comportamiento sea equivalente. Esto reduce superficie de mantenimiento y hace que un cambio visual futuro (ej. cambiar el estilo de badge) se aplique una sola vez. Hacerlo incremental, un componente a la vez, verificando visualmente cada pantalla después.

**2.6 — `LoadingState.tsx` parece no usarse en ninguna parte**
Existe como componente compartido pero `/revision-diaria` tiene su propio `loading.tsx` bespoke y no se encontró otro consumidor. Verificar con un grep completo del repo; si efectivamente no se usa, decidir entre adoptarlo en más rutas (`/empleados`, `/documentos`, `/dashboard` no tienen `loading.tsx` propio hoy) o eliminarlo si quedó obsoleto.

**2.7 — Patrón de botones múltiples por formulario, con `formAction` override**
En `ReviewDetailPanel.tsx`, algunos formularios de decisión usan un solo `<form>` con botones que sobreescriben `formAction` (ej. salida anticipada: "Médico" / "Otro" / "No justificado" en el mismo form apuntando a dos Server Actions distintas). Funciona, pero es un patrón frágil si se agrega un cuarto botón — fácil olvidar setear `formAction` correctamente, y dos botones que comparten `name` para señalar "cuál se apretó" es implícito y no auto-documentado.
→ **Recomendación:** evaluar separar en formularios independientes (como ya se hace en atraso/OT) por consistencia, o documentar explícitamente el patrón si se mantiene por alguna razón (menos DOM, por ejemplo).

**2.8 — Wording inconsistente entre flujos de decisión**
"¿Trabajador con licencia? Sí/No" (ausencias) es menos explícito que "Justificar/No justificar" (atraso) o "Aprobar/Rechazar" (OT) — mismo patrón de decisión binaria, verbos distintos. Revisar y unificar el tono/verbo usado en botones de decisión en toda la pantalla.

**2.9 — Sin ficha de empleado enlazada desde Revisión Diaria (ni viceversa)**
`ReviewDetailPanel` no tiene un link a `/empleados/[id]` para ver el historial de 30 días de ese trabajador, y `/empleados/[id]` no tiene un atajo para "revisar hoy" en Revisión Diaria para ese empleado/fecha. Son las dos pantallas donde más sentido tiene cruzar navegación y hoy no se cruzan.
→ **Recomendación:** agregar un link "Ver ficha completa →" en `ReviewDetailPanel` y un link "Revisar hoy" (o similar) en `/empleados/[id]` cuando ese empleado tenga casos pendientes hoy.

**2.10 — `CommentField` siempre opcional, incluso en decisiones negativas**
El textarea de comentario/justificación es opcional en todos los flujos, incluyendo "No justificar" un atraso o "Rechazar" horas extra — casos donde un comentario probablemente debería ser más que opcional desde el punto de vista de negocio (auditoría de por qué se rechazó). Esto es una decisión de producto, no un bug — señalar para que el dueño del producto confirme si debe requerirse en esos casos específicos antes de cambiar el contrato backend.

### 🟢 Baja prioridad / a confirmar con el dueño del producto

**2.11 — Rediseño de login en curso, mezclando tokens de Tailwind con hex hardcodeado**
El cambio sin commitear en `src/app/login/page.tsx` reemplaza clases del sistema de diseño (`bg-arcotex-blue`, `border-border`, etc.) por valores hex literales (`#2f82bb`, `#111827`, etc.) en ~20 lugares. El resto de la app usa consistentemente el sistema de tokens definido en `globals.css`. Si este approach de hex hardcodeado no es intencional como nuevo estándar, hay que:
  1. Extraer esos valores hex de vuelta a tokens con nombre (o confirmar que ya existen tokens equivalentes y usarlos), y
  2. Terminar de decidir/commitear el rediseño antes de que otros archivos empiecen a copiar el mismo patrón.
`ArcotexLogo.tsx` también cambió de una marca abstracta mínima (`currentColor`, hereda del contenedor) a un wordmark completo con colores fijos + prop `inverse` — API nueva, ya adoptada por `Sidebar.tsx` y `login/page.tsx`. Confirmar que es el diseño final antes de propagarlo a más lugares.

**2.12 — Widgets "a medias" en el dashboard, honestamente etiquetados pero permanentes**
"Asistencia promedio" (WeekSummaryCard) y el feriado/Excel export son gaps documentados con su propio comentario en el código, no bugs — pero ocupan espacio visual fijo en el dashboard principal indefinidamente. Si su implementación real (Fase 9 / servicio de agregación) no tiene fecha próxima, considerar si vale la pena ocultarlos condicionalmente en vez de mostrarlos siempre deshabilitados — decisión de producto, no técnica.

**2.13 — Sin "olvidé mi contraseña" en `/login`**
No existe ningún flujo de recuperación de contraseña visible en el código. Si los usuarios son cuentas corporativas administradas por SUPER_ADMIN (sin auto-registro), esto puede ser intencional — confirmar antes de construir algo.

---

## 3. Orden de ataque sugerido

1. **`/usuarios`** (§2.1) — mayor impacto, backend ya listo, bajo riesgo (no toca reglas de negocio).
2. **Vínculo de documentos** (§2.4) — corrige una inconsistencia real de datos/flujo, no solo estética.
3. **Preservar `empleado` en filtros** (§2.3) — arreglo chico, alto valor percibido para el supervisor.
4. **Retrofit de componentes compartidos** (§2.5–2.6) — hacerlo incremental, pantalla por pantalla, con verificación visual real en navegador después de cada una (no asumir que el CSS se ve bien).
5. **Reducir fricción de navegación en Revisión Diaria** (§2.2) — el cambio más delicado técnicamente, dejar para el final una vez que el resto esté estable.
6. Resolver el rediseño de login en curso (§2.11) antes de que se acumule más deuda de estilo.
7. Los puntos §2.7–2.10 y §2.12–2.13 son mejoras de pulido/consistencia — abordar según tiempo disponible, no bloquean nada más.

---

## 4. Cómo verificar cualquier cambio

Este proyecto tiene una disciplina de verificación real establecida en fases anteriores — mantenerla:

- `npx tsc --noEmit`, lint, y `next build` deben quedar limpios.
- Correr las suites de test existentes (`npm run test:*`) — no deben romperse.
- Para cambios de UI, verificar en navegador real (no asumir), en al menos: desktop (~1440px+) y mobile (~375px), con los 4 roles reales si el cambio afecta scoping o navegación.
- Si se toca `daily-review-view.ts`, `dashboard-view.ts`, o cualquier view-model: verificar que sigue sin N+1 queries (son pantallas con potencialmente decenas de casos) y que el scoping por área sigue aplicado correctamente — hubo bugs reales de esto en fases anteriores (ver commit `b6e832e`).
