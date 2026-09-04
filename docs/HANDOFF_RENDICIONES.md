# Handoff — Rendiciones (rama `claude/hola-e040lp`)

Estado de trabajo, no documento de arquitectura. Borrar cuando se mergee a `master`.

## Dónde estamos

Rama: **`claude/hola-e040lp`** — 14 commits publicados antes del bloque actual.

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

## Fase 1, bloque 3 — completado en PC 2

Se eliminó el caso especial de Rendiciones en
`platform_set_company_module_status()`. El catálogo declara ahora
`tenant_isolated`: los módulos con backend y RLS tenant-aware completos
pueden cambiar de estado aunque el workspace laboral legacy esté operativo.
Rendiciones es el único módulo marcado por ahora; los demás conservan el
bloqueo seguro por defecto.

La configuración inicial de Rendiciones pasó a un trigger de su propio
dominio, por lo que el RPC CORE tampoco conoce
`provision_expense_defaults()`. La migración `20260902140000` implementa el
cambio y la prueba `056` cubre catálogo, bloqueo legacy, comportamiento
genérico, provisión idempotente, autorización y auditoría.

Validación del bloque: reconstrucción desde cero, 56 suites pgTAP / 1.005
aserciones y 711 tests de aplicación en verde (2 opt-in omitidos). TypeScript,
ESLint y lint de base sin errores. Bugbot y Security Review no encontraron
problemas antes del commit.

## Fase 1 cerrada en staging — 3 de septiembre de 2026

La rama se concilió con `origin/master` (sin commits faltantes) y las 80
migraciones quedaron desplegadas en `arcotex-workera-staging` hasta
`20260902140000`. Antes del despliegue se generó un respaldo lógico fuera del
repositorio.

El primer intento descubrió un caso que el reset limpio no representaba: las
marcaciones Workera históricas ya estaban protegidas por el trigger de
inmutabilidad. La migración `20260902070000` ahora suspende ese trigger solo
dentro de su transacción, completa `company_id` y lo restaura. El cambio se
ensayó localmente partiendo desde `20260902060000` con una marcación histórica;
la suite completa quedó en 56 archivos / 1.007 aserciones. Bugbot y Security
Review no encontraron problemas. Commit: `f3485e4`.

Comprobaciones remotas finales: cero marcaciones sin empresa o cruzadas entre
empresas, trigger de inmutabilidad activo, permiso de logs de sincronización
restringido, Rendiciones tenant-aware y RPC del control plane sin casos
especiales. `db lint` y `db push --dry-run` pasaron; la compilación de producción
con el entorno de staging también pasó y las rutas privadas se mantienen
protegidas. Con esto, **la Fase 1 queda cerrada** y el próximo trabajo comienza
en Fase 2.

## Fase 2, bloque 1 — EX-13 p2: controles y alertas

Se amplió la pantalla de indicadores de Rendiciones con seis señales
operacionales para priorizar revisión humana: comprobantes duplicados,
comprobantes obligatorios faltantes, OCR pendiente, fallas de OCR, ítems que
superan límites de política y cobertura de comprobantes. Estas señales no
declaran fraude ni certifican cumplimiento legal.

El cálculo se trasladó a `get_expense_indicators()`, un RPC agregado en
PostgreSQL que exige membresía activa, módulo Rendiciones habilitado y permiso
de lectura, aprobación o administración. El RPC aplica el ámbito de empresa de
forma explícita y evita descargar miles de filas al servidor web para calcular
los totales, eliminando además el riesgo de agregados truncados por el límite de
PostgREST.

La migración `20260902150000` y el test pgTAP `057` cubren permisos, aislamiento
entre empresas, ventana temporal, métricas y alertas. Validación local: reset
completo con las 81 migraciones, 57 suites pgTAP / 1.029 aserciones, 716 tests de
aplicación aprobados (2 opt-in omitidos), TypeScript, ESLint, lint de base y
compilación de producción en verde.

La revisión funcional previa al commit corrigió dos puntos: la alerta de límite
ahora considera solo rendiciones abiertas y las consultas temporales tienen
índices dedicados. Security Review confirmó el aislamiento tenant y llevó a
endurecer `categoryLimits`: valores malformados o sobredimensionados se rechazan
al guardar la política y el agregado evita conversiones numéricas inseguras.

## Fase 2, bloque 2 — bandeja segura de comprobantes

Se agregó una bandeja personal para capturar comprobantes desde un archivo o
directamente con la cámara del teléfono antes de asociarlos a un gasto. Acepta
PDF, JPG y PNG de hasta 10 MiB, ofrece vista previa temporal, indica posibles
duplicados y permite asociar o descartar cada captura. El modelo reserva las
fuentes `EMAIL` y `WHATSAPP` y una clave idempotente para conectores futuros,
pero esos canales externos todavía no están conectados.

La carga ya no escribe directamente desde el navegador en Storage. Un servicio
`server-only` verifica sesión, empresa, módulo y permisos, calcula SHA-256 sobre
los bytes reales y usa `service_role` únicamente después de esas comprobaciones.
Las funciones privilegiadas vuelven a validar actor, empresa, gasto y estado en
PostgreSQL. La lectura sigue siendo privada mediante URL firmada de 60 segundos.

La asociación a un gasto es atómica y exige una rendición `DRAFT`. Se cerraron
las carreras con el envío de la rendición y con cargas simultáneas, se impuso un
máximo estricto de 50 capturas pendientes por persona/empresa y al borrar un
gasto la captura vuelve a la bandeja solo si queda cupo; con la bandeja llena el
borrado se bloquea para no perder evidencia ni dejar archivos huérfanos. El
descarte exige además el `company_id` correcto, por lo que un identificador de
otra empresa no puede cambiar su estado.

La migración `20260902160000` y el test pgTAP `058` cubren privacidad, permisos,
aislamiento entre empresas, IDOR, asociación única, eliminación, límite de la
bandeja y descarte cruzado. Validación local final: reconstrucción completa,
58 suites pgTAP / 1.068 aserciones, 717 tests de aplicación aprobados (2 opt-in
omitidos), TypeScript, ESLint, lint de base y compilación de producción en verde.
Bugbot encontró seis bordes de concurrencia/ciclo de vida y Security Review tres
riesgos de confianza, limpieza de Storage y conservación de evidencia; todos
quedaron corregidos antes del commit.

## Fase 2, bloque 3 — recepción segura por correo

Se conectó la bandeja al canal de correo mediante Resend, manteniéndolo
**deshabilitado por defecto** hasta configurar dominio, API key y webhook en el
entorno. Cada usuario puede activar una dirección opaca distinta por empresa y
reemplazarla si se filtra; rotar el token invalida la dirección anterior.

El endpoint público verifica la firma Svix sobre el cuerpo crudo y solo procesa
`email.received`. Nunca confía en `From`: el token del destinatario se resuelve
con una función `service_role` que revalida en tiempo real empresa, membresía,
módulo y permisos. Se rechazan alias ambiguos, cuerpos sobredimensionados y
descargas fuera del host HTTPS exacto de Resend, sin redirecciones.

El cuerpo se limita por streaming antes de almacenarse en memoria. Tras resolver
el alias, un ledger server-only reclama el evento y reserva cupo antes de llamar
a la API externa; las leases recuperables evitan trabajo duplicado, replays
simultáneos y descargas que no podrían registrarse. Un token de fencing por
intento impide que un worker antiguo consuma o cierre una lease renovada. Las
cuotas horarias de eventos, adjuntos y bytes cuentan incluso contenido inválido.
Los correos sin adjuntos compatibles también entran al ledger y al límite de 20
eventos, pero se completan sin consultar la API del proveedor.
Cada reintento vuelve a contabilizar sus bytes en la ventana vigente, incluso
si el intento anterior falló después de descargar.
Fallos transitorios devuelven 5xx para conservar los reintentos del proveedor y
una URL expirada se renueva una vez antes de fallar.

Los adjuntos se consultan mediante la API del proveedor. Solo se aceptan hasta
10 PDF/JPG/PNG explícitos de 10 MiB o menos, con MIME y firma binaria
coincidentes. El cuerpo y las imágenes inline se ignoran. Una clave SHA-256 por
correo/adjunto hace los reintentos idempotentes, comparte el cupo estricto de 50
pendientes con la captura web y limpia el objeto no canónico ante carreras.

La migración `20260902170000` y el test pgTAP `059` cubren RLS, permisos,
aislamiento, rotación, revocación por membresía, Storage, ruta tenant-aware,
idempotencia, reservas y recuperación de reintentos. Validación local posterior
a correcciones de revisión: reset completo, 59 suites pgTAP / 1.145 aserciones,
735 tests de aplicación aprobados (2 opt-in omitidos), TypeScript, ESLint, lint
de base, auditoría de dependencias y build de producción en verde. La operación
y variables requeridas están documentadas en `docs/EXPENSE_EMAIL_CAPTURE.md`.
La migración quedó aplicada y verificada en `arcotex-workera-staging`; el
proveedor continúa deshabilitado hasta configurar dominio y secretos de Resend.

## Fase 2, bloque 4 — recepción segura por WhatsApp

Se conectó la bandeja al canal de WhatsApp Cloud API. El proveedor permanece
**deshabilitado por defecto**: la verificación GET del callback funciona cuando
los secretos están completos, pero ningún POST se procesa hasta activar el
interruptor operativo.

Cada persona genera desde la bandeja un código aleatorio de 96 bits, de un solo
uso y con vencimiento de 10 minutos, y envía `VINCULAR <código>` al número
empresarial. El número/`wa_id` real nunca se persiste; se guarda únicamente un
HMAC-SHA256 con un secreto independiente. Un número solo puede apuntar a una
persona/empresa a la vez y el vínculo se puede revocar. Membresía, módulo y
permisos se vuelven a validar en cada mensaje.

El webhook verifica `X-Hub-Signature-256` sobre el cuerpo crudo, limita el body a
512 KiB y acepta únicamente eventos del `phone_number_id` configurado. Las URLs
temporales de media deben usar HTTPS y uno de los hostnames exactos permitidos,
sin redirecciones. Antes de almacenar se aplican timeout, límite de 10 MiB y
validación conjunta de MIME y firma binaria.

Un ledger con leases y tokens de fencing hace la ingesta idempotente y
recuperable ante reintentos. Las cuotas durables limitan a 60 eventos y 100 MiB
por persona/empresa/hora, compartiendo además el máximo de 50 comprobantes
pendientes de la bandeja. Storage sigue siendo privado y las rutas incluyen
empresa y usuario. El despliegue controlado y las variables están documentados
en `docs/EXPENSE_WHATSAPP_CAPTURE.md`.

La migración `20260904170000` y el test pgTAP `060` cubren privilegios, RLS,
aislamiento, IDOR, código de un solo uso, revocación, reintentos, cuotas, Storage
e idempotencia. Validación local aislada: reset completo, 60 suites pgTAP / 1.207
aserciones, 750 tests de aplicación (748 aprobados y 2 opt-in omitidos),
TypeScript, ESLint, lint de base, auditoría de dependencias y build de producción
en verde. El canal todavía no fue aplicado ni activado en staging.

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
