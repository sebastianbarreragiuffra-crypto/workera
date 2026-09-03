# Handoff — Rendiciones (rama `claude/hola-e040lp`)

Estado de trabajo, no documento de arquitectura. Borrar cuando se mergee a `master`.

## Dónde estamos

Rama: **`claude/hola-e040lp`** — 12 commits, todo pusheado a `origin`.

Se venía construyendo **Rendiciones** (la alternativa mejorada a RindeGastos)
por fases chicas, y después se hizo una **auditoría técnica en dos vueltas**.

### Funcionalidad agregada (en orden)

| Commit | Qué |
|---|---|
| `7d50584` | Pulido EX-1..EX-6 (mensajes de error, validación de categorías, DRY) |
| `be3ea52` | Planilla mensual de reembolso a empleados (Excel) |
| `227e39d` | **EX-7 backend**: anticipos y fondos por rendir (tabla + 5 RPC) |
| `11b389e` | **EX-7 UI**: pantalla de anticipos + vinculación a rendiciones |
| `1c7b6ed` | **EX-13 p1**: indicadores (tiempo de aprobación, gasto por categoría) |
| `6e29cce` | Centro de costo (`organization_unit_id`) conectado a Rendiciones |
| `eea70ea` | **EX-8 p1**: kilometraje (tarifa por km, monto calculado en servidor) |
| `6b00537` | **EX-8 p2**: viáticos/per diem (+ constraint XOR con kilometraje) |
| `a638eb5` | Fase 1 b2: link a Rendiciones desde el control plane |
| `af47e4a` | Fase 1 b1: `error/loading/not-found` de Rendiciones + fix `retry()` |
| `ecb363c` | Fase 1 b2: 13 tests de `access.ts` (verificados por mutación) |

## Validación completada en PC 2 — 3 de septiembre de 2026

Las migraciones y tipos que habían quedado pendientes ya fueron validados
contra una instancia Supabase local reconstruida desde cero:

```bash
npx supabase db reset
npx supabase gen types typescript --local > src/lib/supabase/database.types.ts
npx supabase test db
```

Resultado: `db reset` correcto, 55 suites pgTAP / 986 aserciones en verde,
711 tests de aplicación aprobados (2 opt-in omitidos), TypeScript, ESLint y
`supabase db lint` sin errores.

Los tipos se regeneraron desde la base. Se conservaron tres ajustes que el
generador no puede inferir desde PostgreSQL: `p_purpose` acepta `null`,
`p_advance_id` acepta `null` para desvincular y
`workera_attendance_events.company_id` es opcional al insertar porque el
trigger lo deriva en el servidor desde `employees.company_id`.

Migraciones a validar: `20260902090000` (anticipos), `100000` (centro de
costo), `110000` (kilometraje), `120000` (viáticos).
Tests pgTAP nuevos: `051`, `052`, `053`, `054`.

La validación también corrigió las policies tenant-aware de Workera y del
motor de reglas. Su bitácora técnica usa el permiso separado
`attendance.sync.read`, otorgado solo a `COMPANY_OWNER` y `HR_ADMIN`; la
prueba `055` confirma que supervisores y auditores conservan la lectura de
marcaciones, pero no ven reintentos ni `error_summary`.

## Dónde seguir (Fase 1, bloque 3)

La auditoría (Fase 0 v2) dejó un hallazgo abierto, el único que falta:

**`platform_set_company_module_status()` tiene `'expenses'` hardcodeado.**
Es una función CORE del control plane que Rendiciones redefinió (en
`20260901190000` y `20260901191000`) para (a) permitir cambiar ese módulo
aunque el workspace esté operativo y (b) llamar a `provision_expense_defaults()`
al habilitarlo.

Funciona hoy, pero **el próximo módulo tenant-aware va a exigir volver a
editar esa función core y agregarle otra rama**. Hay que decidir entre:
1. Dejarlo (es una excepción documentada, hay un solo módulo así hoy).
2. Generalizarlo: mover la excepción a un flag del `module_catalog`
   (ej. `tenant_isolated boolean`) y que la función lea el flag en vez de
   comparar contra un string.

Es una decisión de arquitectura, no un fix mecánico — conviene discutirla
antes de tocar nada.

## Otros hallazgos ya cerrados (no rehacer)

- ✅ Link faltante `(platform)` → Rendiciones — hecho (`a638eb5`).
- ✅ Sin `error/loading/not-found` en Rendiciones — hecho (`af47e4a`).
  Ojo: se descubrió que `reset()` no re-hace fetch en Next 16.3; el correcto
  es `retry()`. Se corrigió también el mismo bug preexistente en
  `(platform)/plataforma/error.tsx`.
- ✅ `access.ts` sin tests — hecho (`ecb363c`).
- ⏸️ Orden de redirect en `/` (no prioriza Rendiciones para quien tiene
  ambos accesos) — se decidió **dejarlo como está**, no es un bug.
- ❌ **EX-9 (aprobación por organigrama) está descartado por ahora**: el
  único vínculo persona↔unidad organizacional es `employee_org_assignments`,
  que apunta a `employees` (dominio laboral, solo ARCOTEX). Construirlo hoy
  daría una función que solo sirve a un cliente. Requiere primero un modelo
  de responsables basado en `profiles`/`company_memberships`.

## Fases de producto pendientes

EX-13 más indicadores (fraude, cumplimiento) · canales de captura
(email/WhatsApp/foto) · conciliación bancaria automática · integraciones
ERP/contabilidad · app móvil · asistente de IA.

## Cómo se viene trabajando

Cada fase: código → `tsc` + `lint` + tests → **revisión de errores con
`/code-review` ANTES de comitear** → arreglar lo encontrado → commit + push.
Las 5 últimas fases encontraron entre 2 y 4 problemas reales cada una en esa
revisión previa. No saltarse ese paso.
