# Rate Limiting y Protección contra Abuso

Estado: `PARTIALLY_IMPLEMENTED`. Rendiciones ya posee cuotas durables para
ingreso bancario y conectores, además de autorización + rate limit + auditoría
atómica para sus cuatro entregas financieras. La carga/descarga de documentos
y las tres exportaciones laborales están cubiertas; login, Server Actions
laborales de decisión y el borde público conservan brechas explícitas. Las
ocho mutaciones del control plane ya usan cuota PostgreSQL fail-closed.
Los valores marcados `TBD`/`PROPOSED` siguen sin ser decisiones finales.

Fuentes oficiales consultadas: [Supabase Auth Rate Limits](https://supabase.com/docs/guides/auth/rate-limits) (documentación oficial, consultada en este gate), [OWASP API Security Top 10 — API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) (verificado contra el documento oficial en este gate de hardening), RFC 6585 (`429 Too Many Requests`), RFC 9110 §10.2.3 (`Retry-After`).

Ver también: `docs/THREAT_MODEL.md` (T-11, T-12, T-15), `docs/API_SECURITY_STANDARD.md`.

## 1. Estado actual verificado

`supabase/config.toml`, sección `[auth.rate_limit]`, valores por defecto del CLI local:

| Límite | Valor local |
|---|---|
| Envío de emails (signup/recovery) | 2/hora |
| SMS OTP | 30/hora |
| Signups anónimos | 30/hora |
| Refresh de token | 150/5min *(nota: la documentación oficial actual de Supabase indica 1800/hora como default hosted — el valor de `config.toml` es específico del CLI local y no debe asumirse igual a producción)* |
| Sign-in/sign-up | 30/5min |
| Verificación de OTP | 30/5min |
| Web3 | 30/5min |

Estos valores son de la **configuración local de desarrollo**, no evidencia del
proyecto hospedado. `[auth.captcha]` está presente pero deshabilitado.

### 1.1 Rendiciones (`IMPLEMENTED_LOCAL`)

`authorize_expense_data_access()` revalida identidad, empresa, módulo, permiso,
recurso y cuarentena; luego actualiza atómicamente un contador compartido y
escribe `expense_audit_events` en la misma transacción. Los contadores son por
`company_id + actor_id + scope`, mantienen una sola fila por combinación y por
eso funcionan aunque Next.js escale a múltiples instancias.

| Superficie | Límite inicial | Ventana |
|---|---:|---:|
| Abrir comprobante registrado | 60 | 5 min |
| Abrir captura propia | 60 | 5 min |
| Exportar conciliación mensual | 10 | 1 h |
| Descargar snapshot contable | 20 | 1 h |

Al excederlo se responde `429` con `Retry-After`; si el control no puede
confirmar la autorización, la entrega falla cerrada con `503`. El evento guarda
actor, empresa, alcance y UUID técnico, nunca archivo, pathname, filtro, IP ni
contenido financiero. La migración y sus 35 invariantes están en
`20260905110000_expense_data_access_guard.sql` y
`073_expense_data_access_guard.sql`.
Cada acceso permitido se audita; del tráfico ya bloqueado se conserva una señal
por ventana para impedir que el propio ledger se convierta en un vector de DoS.

También están implementadas las cuotas horarias de la importación bancaria y
las cuotas/ledgers de correo y WhatsApp. Estas últimas no autorizan activar los
conectores: siguen faltando rate limit de borde y proveedor antimalware.

## 2. Brechas y diseño restante (`PLANNED` — `TBD` donde se indica)

Para cada operación: clave de identidad, ventana, límite propuesto, justificación, respuesta 429, `Retry-After`, auditoría, alertas, riesgo NAT/proxy, headers confiables, almacenamiento, comportamiento ante caída, protección anti-bypass.

### 2.1 Login (`supabase.auth.signInWithPassword`)
- **Clave**: combinación IP + email normalizado (evita que un atacante rote solo IP o solo cuenta).
- **Ventana**: 5 minutos.
- **Límite propuesto**: `TBD` — punto de partida sugerido 10 intentos/5min por combinación IP+email, más el límite nativo de Supabase Auth (`sign_in_sign_ups`) como segunda capa. Requiere decisión de producto (¿bloqueo temporal vs. CAPTCHA progresivo?).
- **Justificación**: mitiga T-11 (brute force/credential stuffing) sin depender exclusivamente de límites de plataforma no confirmados para el proyecto hosted real.
- **Respuesta 429**: body genérico (`{"error":"too_many_requests"}`), sin revelar si el límite es por IP o por cuenta (evita ayudar a un atacante a afinar su ataque).
- **`Retry-After`**: sí, en segundos, calculado desde el inicio de la ventana.
- **Auditoría**: registrar el evento de rate-limit alcanzado (sin email/PII en el log — solo un hash o el hecho del evento) para detección de patrones.
- **Alertas**: `TBD` — umbral de alertas operacionales a definir cuando exista monitoreo real.
- **Riesgo NAT/proxy**: alto — múltiples usuarios legítimos detrás de la misma IP corporativa podrían compartir el contador. Mitigación propuesta: combinar con la clave de email reduce el falso positivo por IP compartida.
- **Encabezados confiables**: si se usa un proxy/CDN delante de la app (ej. Vercel), usar el header de IP real que la plataforma de hosting garantiza (no confiar en `X-Forwarded-For` sin verificar que proviene de un proxy de confianza — un atacante puede falsificarlo si no se sanea). Para el proyecto Supabase en sí, la documentación oficial define `Sb-Forwarded-For` como el mecanismo soportado para reenviar la IP real del usuario final desde un backend server-side, pero exige habilitarlo explícitamente por proyecto y usar una clave secreta — **no habilitado hoy, no existe proyecto hosted**.
- **Almacenamiento**: `TBD` — requiere un store distribuido si la app corre en múltiples instancias (ej. Redis/Upstash); no decidido, depende de la plataforma de despliegue futura.
- **Ante caída del rate limiter**: fail closed vs. fail open es una decisión de producto — propuesta: fail closed para login (preferir bloquear temporalmente antes que permitir brute force sin control) si el store de rate limiting no responde; requiere confirmación.
- **Anti-bypass**: no confiar únicamente en el rate limit de Supabase Auth (es una única capa); no exponer en la respuesta si el límite alcanzado es de IP o de cuenta.

### 2.2 Recuperación de contraseña
- **Clave**: email destino.
- **Ventana**: 1 hora, alineado al límite nativo de envío de emails de Supabase Auth (2/hora en local; confirmar el valor real del plan hosted futuro).
- **Límite propuesto**: heredado del límite nativo de Supabase Auth mientras no se confirme una necesidad de capa adicional.
- **Justificación**: previene spam de emails de recuperación hacia terceros (abuso, no solo seguridad de cuenta propia).
- **Respuesta 429 / `Retry-After`**: igual criterio que login.
- **Auditoría**: registrar el evento sin exponer el email en texto plano en logs de aplicación.
- **Riesgo NAT/proxy**: bajo (clave es el email, no la IP).
- **Anti-bypass**: no permitir enumerar si un email existe a partir de la respuesta (mismo criterio ya aplicado en `login/actions.ts`: mensaje genérico).

### 2.3 Otras APIs y Route Handlers
- **Clave**: inventariada por ruta en `src/lib/architecture/request-surfaces.ts`;
  falta cerrar las superficies que aún figuran con `MISSING`.
- **Ventana**: `TBD` por endpoint, a definir junto con cada ruta nueva siguiendo `docs/API_SECURITY_STANDARD.md`.
- **Límite propuesto**: `TBD` para cada superficie que el inventario marca pendiente; calibrar con volumen sintético y marcha blanca.
- **Justificación**: mitigar abuso de recursos (OWASP API4:2023) en endpoints existentes y futuros.
- **Respuesta 429 / `Retry-After`**: mismo estándar que el resto.
- **Auditoría/alertas**: `TBD`, depende de la observabilidad elegida.
- **Anti-bypass**: rate limiting debe aplicarse server-side, nunca solo en el cliente.

### 2.4 Acciones de aprobación (overtime, atrasos, ausencias)
- **Clave**: usuario (`sub`) que aprueba.
- **Ventana**: `TBD` — probablemente más laxa que login (son acciones legítimas frecuentes de un supervisor durante su jornada), pero con un límite superior razonable para detectar automatización anómala.
- **Límite propuesto**: `TBD` — requiere entender el volumen operacional real (cuántos trabajadores por supervisor) antes de proponer un número, para no bloquear uso legítimo.
- **Justificación**: detectar un script automatizando aprobaciones masivas fuera del patrón humano esperado (T-25, insider threat).
- **Auditoría**: cada aprobación ya debe quedar en `audit_log` (regla de `ARCHITECTURE.md`) — el rate limit es una capa adicional de detección, no el mecanismo de auditoría en sí.

### 2.5 Exportaciones laborales legacy (`IMPLEMENTED_LOCAL`)
- **Clave**: `company_id + actor_id + scope`, con ARCOTEX derivada en DB; el
  cliente no puede elegir la empresa mientras estas tablas sigan legacy.
- **Ventana/límite inicial**: asistencia 20/hora, lote de nómina 20/hora y
  maestro de proveedores 10/hora.
- **Autorización**: `authorize_workforce_data_access()` exige membresía activa,
  rol, AAL2 cuando corresponde, período/recurso allowlisted y fila ACTIVE.
- **Respuesta**: `429` con `Retry-After`; si el guard no responde se usa `503`.
  Los archivos se fuerzan como attachment, sin caché ni signed URL al navegador.
- **Auditoría**: autorización y primer bloqueo de cada ventana quedan en
  `audit_log`, con empresa, scope, período y UUID técnico; nunca filas, cuentas
  bancarias, ruta ni nombre de archivo.
- **Pendiente**: calibrar límites con carga sintética y migrar las tablas a
  `company_id` antes de admitir un segundo workspace laboral.

### 2.6 Upload de documentos laborales (`IMPLEMENTED_LOCAL`)
- **Clave**: usuario autenticado (`auth.uid()`).
- **Ventana**: hora calendario fija en PostgreSQL.
- **Límite inicial**: 30 reservas y 100 MiB acumulados por actor/hora; además,
  cada archivo se limita a 10 MiB en aplicación, RPC y bucket.
- **Anti-bypass**: Storage solo acepta una ruta reservada por 10 minutos para
  ese actor; el contador usa advisory lock y no depende de la instancia de
  Next.js. MIME/extensión se fijan en DB y magic bytes se validan antes de subir.
- **Auditoría**: cada commit de metadata escribe `SUPPORTING_DOCUMENT_UPLOADED`;
  un intento fallido no amplifica la bitácora.
- **Pendiente**: calibrar valores con marcha blanca, conectar antimalware y
  operar un sweeper de reservas vencidas.

### 2.7 Descarga de documentos laborales (`IMPLEMENTED_LOCAL`)
- **Clave**: `company_id + actor_id + supporting_document.download`.
- **Ventana/límite inicial**: 60 autorizaciones cada 5 minutos.
- **Anti-bypass**: el RPC y la policy de Storage revalidan rol privilegiado,
  AAL2, documento y membresía activa en la empresa derivada del trabajador.
- **Respuesta**: `429` con `Retry-After`; una caída del guard devuelve `503`.
  La ruta sirve un adjunto privado y nunca una signed URL al navegador.
- **Auditoría**: cada autorización y el primer bloqueo de la ventana se escriben
  en `audit_log`; el contador se satura en 62 para evitar amplificación.
- **Pendiente**: calibrar el valor y conectar alertas/telemetría hospedada.

### 2.8 Sincronización con Workera (implementada pero apagada)
- **Clave**: N/A (proceso server-to-server, no un usuario final) — control por diseño del cron/job, no por rate limit de usuario.
- **Ventana/límite**: `TBD` — depende enteramente de los rate limits que la propia Workera imponga, que hoy son desconocidos (sin documentación oficial). El intento manual previo que recibió `HTTP 429` de Workera confirma que Workera **sí aplica rate limiting del lado servidor**, pero no revela su umbral exacto ni su ventana.
- **Justificación**: evitar que un reintento mal configurado sature la API de Workera y active sus propios límites o bloqueos.
- **Anti-bypass**: respetar cualquier header `Retry-After` que Workera devuelva (ya contemplado conceptualmente en `WorkeraRateLimitError.retryAfterMs` en `errors.ts`, aunque sin cliente HTTP real que lo dispare todavía).

### 2.9 Mutaciones del control plane (`IMPLEMENTED_LOCAL`)
- **Clave**: `actor_id + company_id opcional + scope`; la empresa y el recurso
  se verifican en el mismo RPC antes de consumir cuota.
- **Ventana**: 1 hora en PostgreSQL compartido, independiente de la cantidad de
  instancias Next.js.
- **Límites iniciales**: alta de empresa 5; reset MFA 10; invitación/reenvío y
  asignación de rol 30; módulo y organigrama 60; onboarding 120.
- **Cobertura**: las ocho acciones exportadas por `/plataforma/actions.ts`.
  Todas exigen sesión, rol OWNER/ADMIN (OWNER exclusivo para reset MFA), AAL2,
  empresa/recurso coherentes y luego repiten autorización en el RPC de negocio.
- **Fallo**: si autorización o cuota no pueden comprobarse, no se inicia la
  mutación ni el efecto externo de invitación. El primer bloqueo por ventana se
  escribe en `platform_audit_log`; no se guardan formularios, emails ni payloads.
- **Pendiente**: calibrar límites y conectar el ledger a alertas hospedadas.

### 2.10 Acciones laborales de decisión (`PLANNED`)
- **Clave**: empresa + usuario que decide.
- **Ventana/límite**: `TBD`; debe medirse el volumen real por supervisor para no
  bloquear una revisión legítima de jornada.
- **Cobertura pendiente**: atrasos, horas extra, ausencias, correcciones,
  licencias, períodos y configuraciones heredadas de ARCOTEX.
- **Justificación**: una cuenta comprometida no debe automatizar decisiones
  laborales masivas fuera de un patrón humano esperado.
- **Auditoría**: cada decisión conserva su ledger de negocio; la cuota será una
  capa de detección adicional, nunca el mecanismo de autorización.

## 3. Consideraciones transversales

- **Almacenamiento distribuido**: Rendiciones usa Postgres compartido y no
  requiere afinidad de instancia. Login/borde puede necesitar un store dedicado
  según el hosting y la latencia que se midan.
- **Comportamiento ante caída del rate limiter**: las entregas financieras de
  Rendiciones, las descargas/exportaciones laborales y el control plane ya son
  fail-closed. Falta decidirlo para login, borde y decisiones laborales.
- **Protección contra bypass**: el rate limiting nunca debe ser la única defensa (ver capas ya implementadas: RLS, guard de sesión, validación de contraseña de Supabase Auth); nunca confiar en un header de IP sin verificar la cadena de confianza del proxy que lo generó.
- **Encabezados confiables**: cualquier IP usada para limitar debe venir de una fuente verificada por la plataforma de hosting (no aceptar `X-Forwarded-For` arbitrario de un cliente no confiable) — mismo principio que Supabase exige para habilitar `Sb-Forwarded-For`.

## 4. Qué todavía NO está implementado

No hay aún control propio para login/recuperación, rate limit de borde para
webhooks ni protección de volumen para decisiones laborales heredadas. Los defaults de Auth local no deben
asumirse válidos en producción: deben confirmarse y ensayarse en el proyecto
hospedado.
