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

## ⚠️ LO PRIMERO QUE HAY QUE HACER EN PC 2

Las migraciones SQL nuevas **nunca corrieron contra una base real** (el
entorno remoto no tiene Docker). Antes de seguir con nada:

```bash
git fetch origin claude/hola-e040lp && git checkout claude/hola-e040lp
npx supabase db reset
npx supabase gen types typescript --local > src/lib/supabase/database.types.ts
npx supabase test db
```

**Por qué importa el `gen types`:** las entradas de `expense_advances`,
`expense_reports.advance_id`, `expense_items.distance_km` / `per_diem_days`
y 4 RPC fueron escritas **a mano** en `database.types.ts`. Se auditaron
columna por columna contra el SQL y coinciden, pero un typo ahí compila
igual y solo falla en runtime. El `git diff` después de regenerar es la
prueba definitiva.

Migraciones a validar: `20260902090000` (anticipos), `100000` (centro de
costo), `110000` (kilometraje), `120000` (viáticos).
Tests pgTAP nuevos: `051`, `052`, `053`, `054`.

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
