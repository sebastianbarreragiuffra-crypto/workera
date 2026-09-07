# Rate limit perimetral — configuración y evidencia hospedada

Estado: `IMPLEMENTED_LOCAL_REQUIRES_HOSTED_EVIDENCE`.

La aplicación integra `@vercel/firewall` en `src/proxy.ts` y selecciona sólo
rutas/métodos sensibles mediante `src/lib/shared/edge-rate-limit.ts`. Los
contadores pertenecen al WAF de Vercel, no a memoria de la Function. La
activación real no está versionada en `vercel.json`: Vercel administra estas
reglas desde Firewall (o su API/Terraform), por lo que este documento es el
contrato exacto que debe aplicarse y evidenciarse en el proyecto hospedado.

## Identidad y capas

- El límite perimetral usa la IP que Vercel entrega en
  `x-vercel-forwarded-for`, únicamente cuando `VERCEL=1`. Se ignoran
  `x-forwarded-for` y `x-real-ip` aportados por el caller. Una identidad
  ausente, inválida o con una cadena ambigua falla cerrada con `503`.
- La precondición es que el cliente llegue directamente a Vercel. Si existe un
  proxy superior, se debe contratar y configurar Trusted Proxy Enterprise;
  de lo contrario Vercel puede observar la IP del proxy y agrupar usuarios.
- `@vercel/firewall` 1.2.5 agrega un hash a la clave, pero también envía la IP
  cruda como prefijo al WAF. Los logs propios sólo incluyen `event`, `policyId`
  y el nombre del tipo de error; la retención y acceso a la IP en Vercel deben
  aprobarse como telemetría del proveedor.
- La IP contiene abuso antes de verificar cuerpos o firmas. Las cuotas
  PostgreSQL existentes siguen aislando por empresa/actor/proveedor después de
  autenticar la solicitud. El WAF no reemplaza firma, sesión, RLS, idempotencia,
  leases ni cuotas durables de negocio.
- Vercel documenta que sus contadores de borde son regionales. La prueba
  hospedada debe medir el agregado multi-región; no se presume exactitud global.

## Reglas que debe crear Platform/Security

En Vercel: proyecto de staging sintético → Firewall → Configure → New Rule. Para
cada fila, elegir la condición `@vercel/firewall`, usar el ID exacto, estrategia
Fixed Window, clave IP y respuesta `429`.

| ID | Superficie | Límite inicial | Ventana | Motivo |
|---|---|---:|---:|---|
| `gestora-login` | `POST /login` (Server Actions de acceso) | 10 | 5 min | Frenar credential stuffing antes de Supabase Auth. |
| `gestora-mfa-challenge` | `POST /login/mfa` | 10 | 5 min | Acotar intentos de desafío MFA además del control de Supabase. |
| `gestora-mfa-management` | `POST /seguridad/mfa` | 10 | 5 min | Acotar inscripción, confirmación y baja de factores. |
| `gestora-auth-callback` | `GET /auth/callback` | 30 | 1 min | Acotar intercambio OAuth sin castigar navegación normal. |
| `gestora-auth-confirm` | `GET /auth/confirm` | 30 | 1 min | Acotar verificación de enlaces/OTP. |
| `gestora-meta-verify` | `GET /api/webhooks/meta/expense-receipts` | 20 | 10 min | El desafío es esporádico y público. |
| `gestora-meta-events` | `POST /api/webhooks/meta/expense-receipts` | 120 | 1 min | Tolera ráfagas del proveedor; la cuota tenant continúa en DB. |
| `gestora-resend-events` | `POST /api/webhooks/resend/expense-receipts` | 120 | 1 min | Tolera entrega/reintentos del proveedor; la cuota tenant continúa en DB. |

No crear una regla global para `/_next/*`, assets, páginas públicas de lectura,
crons con secreto ni rutas privadas ya contenidas por sesión y cuotas de
aplicación. Los límites son iniciales: calibrarlos con tráfico sintético y luego
con métricas de marcha blanca, sin incluir identificadores personales.

## Orden de canario

1. Crear las ocho reglas en el proyecto de staging con acción de observación
   (`Log`) y confirmar por 30 minutos que sólo coinciden los IDs esperados.
2. Desplegar el código con `EDGE_RATE_LIMIT_ENABLED=false` y
   `EDGE_RATE_LIMIT_EXPECT_ENABLED=false`; este estado no consulta el WAF y
   evita que un merge dependa de reglas aún no publicadas.
3. Cambiar a Rate Limit/`429`, publicar, poner
   `EDGE_RATE_LIMIT_ENABLED=true` sólo en Preview y redesplegar con
   Protection Bypass for Automation y System Environment Variables habilitados,
   tal como exige el SDK de Vercel para Preview.
4. Por cada ID, enviar `límite` solicitudes permitidas y una adicional. Guardar
   timestamp UTC, deployment SHA, ID de regla, región, códigos y headers. La
   adicional debe responder `429`, JSON `{"error":"too_many_requests"}`,
   `Cache-Control: no-store` y `Retry-After` igual a la ventana en segundos.
5. Repetir desde dos regiones y con dos IP sintéticas: una identidad agotada no
   debe bloquear la otra. Repetir después de vencer la ventana para demostrar
   recuperación.
6. Probar spoofing enviando valores distintos en `x-forwarded-for`, `x-real-ip`
   y `x-vercel-forwarded-for`; Vercel debe reemplazar este último y ninguno debe
   crear buckets alternativos. Un test directo que no pase por Vercel no es
   evidencia válida de este punto.
7. Verificar que una caída o un ID borrado entrega `503` sólo en las ocho
   superficies sensibles, mientras assets, salud, navegación y crons siguen
   operativos. Confirmar que no aparecen IP, email, tokens o payloads en logs.
8. Promover primero las mismas ocho reglas a producción, verificar que existen,
   y sólo después activar `EDGE_RATE_LIMIT_ENABLED=true`. Tras el canario,
   fijar también `EDGE_RATE_LIMIT_EXPECT_ENABLED=true`: desde entonces una
   regresión del flag o una ejecución fuera de Vercel falla cerrada. Mantener
   conectores apagados hasta cerrar además sus gates propios.

## Rollback

Si el canario bloquea tráfico legítimo, poner primero ambos flags en `false` y
redesplegar el SHA aprobado. Después deshabilitar la regla afectada en Firewall;
Vercel conserva configuraciones previas para rollback. No ampliar a una regla
global ni poner el SDK en fail-open. Mantener desactivado el conector afectado,
registrar el ID y la ventana que causaron el incidente, ajustar una sola regla y
repetir el canario completo antes de reactivar.

## Evidencia requerida para cerrar el gate

El gate `EDGE_RATE_LIMIT` permanece `REQUIRES_HOSTED_EVIDENCE` hasta adjuntar:

- export/captura de las ocho reglas publicadas y su revisión de acceso;
- resultados 429/`Retry-After`, aislamiento, spoofing, concurrencia,
  multi-región y recuperación del deployment candidato;
- consulta de telemetría sin PII, alerta operativa y responsable;
- rollback ensayado y decisión de límites/costo aprobada por Platform/Security.

Fuentes oficiales consultadas el 7 de septiembre de 2026:

- https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting
- https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk
- https://vercel.com/docs/headers/request-headers
- https://vercel.com/docs/vercel-firewall/vercel-waf/custom-rules
