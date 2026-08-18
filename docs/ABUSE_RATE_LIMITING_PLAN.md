# Rate Limiting y Protección contra Abuso — plan (propuesta, no implementada)

Estado: `PLANNED`. **Ningún límite descrito aquí está implementado en código.** Los valores numéricos son propuestas provisionales marcadas explícitamente `TBD`/`PROPOSED` — no son una decisión final, requieren confirmación (ver `docs/DECISIONS_PENDING.md`). Hoy, la única protección real y verificable son los rate limits **por defecto del proyecto local de Supabase CLI** (`supabase/config.toml`), que son configuración de desarrollo, no una decisión de producto para producción.

Fuentes oficiales consultadas: [Supabase Auth Rate Limits](https://supabase.com/docs/guides/auth/rate-limits) (documentación oficial, consultada en este gate), [OWASP API Security Top 10 — API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0x11-t10/) (verificado contra el documento oficial en este gate de hardening), RFC 6585 (`429 Too Many Requests`), RFC 9110 §10.2.3 (`Retry-After`).

Ver también: `docs/THREAT_MODEL.md` (T-11, T-12, T-15), `docs/API_SECURITY_STANDARD.md`.

## 1. Estado actual verificado (`IMPLEMENTED`, solo entorno local)

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

Estos valores son de la **configuración local de desarrollo**, no de un proyecto Supabase hosted real (no existe todavía). `[auth.captcha]` está presente en `config.toml` pero **deshabilitado** (comentado). Sin MFA. Sin rate limiting propio de aplicación en ningún punto del código.

## 2. Diseño propuesto por operación (`PLANNED` — `TBD` donde se indica)

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

### 2.3 Futuras APIs (`/api/*`, hoy inexistentes)
- **Clave**: `TBD` — propuesta: usuario autenticado (via `sub` del claim) para rutas protegidas; IP para las pocas rutas públicas que pudieran existir.
- **Ventana**: `TBD` por endpoint, a definir junto con cada ruta nueva siguiendo `docs/API_SECURITY_STANDARD.md`.
- **Límite propuesto**: `TBD` — ninguna ruta existe todavía para calibrar un límite razonable.
- **Justificación**: mitigar abuso de recursos (OWASP API4:2023) una vez que existan endpoints reales.
- **Respuesta 429 / `Retry-After`**: mismo estándar que el resto.
- **Auditoría/alertas**: `TBD`, depende de la observabilidad elegida.
- **Anti-bypass**: rate limiting debe aplicarse server-side, nunca solo en el cliente.

### 2.4 Acciones de aprobación (overtime, atrasos, ausencias — futuras)
- **Clave**: usuario (`sub`) que aprueba.
- **Ventana**: `TBD` — probablemente más laxa que login (son acciones legítimas frecuentes de un supervisor durante su jornada), pero con un límite superior razonable para detectar automatización anómala.
- **Límite propuesto**: `TBD` — requiere entender el volumen operacional real (cuántos trabajadores por supervisor) antes de proponer un número, para no bloquear uso legítimo.
- **Justificación**: detectar un script automatizando aprobaciones masivas fuera del patrón humano esperado (T-25, insider threat).
- **Auditoría**: cada aprobación ya debe quedar en `audit_log` (regla de `ARCHITECTURE.md`) — el rate limit es una capa adicional de detección, no el mecanismo de auditoría en sí.

### 2.5 Exportación Excel (futura)
- **Clave**: usuario.
- **Ventana**: `TBD` — propuesta inicial: pocas exportaciones por hora son normales (es un reporte semanal/mensual, no una acción de alta frecuencia).
- **Límite propuesto**: `TBD`.
- **Justificación**: mitiga T-12 (abuso de exportaciones para exfiltración masiva de datos de remuneración).
- **Auditoría**: cada exportación queda registrada en `excel_exports` (tabla ya existente) — el rate limit complementa, no reemplaza, ese registro.

### 2.6 Upload de documentos (futuro, cuando exista Storage)
- **Clave**: usuario.
- **Ventana**: `TBD`.
- **Límite propuesto**: `TBD`, junto con el límite de tamaño por archivo (ver `docs/API_SECURITY_STANDARD.md`, `413`).
- **Justificación**: mitiga T-13/T-15 (carga maliciosa, payloads grandes repetidos).

### 2.7 Sincronización con Workera (futura, hoy bloqueada)
- **Clave**: N/A (proceso server-to-server, no un usuario final) — control por diseño del cron/job, no por rate limit de usuario.
- **Ventana/límite**: `TBD` — depende enteramente de los rate limits que la propia Workera imponga, que hoy son desconocidos (sin documentación oficial). El intento manual previo que recibió `HTTP 429` de Workera confirma que Workera **sí aplica rate limiting del lado servidor**, pero no revela su umbral exacto ni su ventana.
- **Justificación**: evitar que un reintento mal configurado sature la API de Workera y active sus propios límites o bloqueos.
- **Anti-bypass**: respetar cualquier header `Retry-After` que Workera devuelva (ya contemplado conceptualmente en `WorkeraRateLimitError.retryAfterMs` en `errors.ts`, aunque sin cliente HTTP real que lo dispare todavía).

### 2.8 Acciones administrativas (`ADMIN_RRHH`: cambio de rol, cierre de período)
- **Clave**: usuario administrador.
- **Ventana/límite**: `TBD` — son acciones infrecuentes por diseño; un límite bajo (ej. unas pocas por hora) es razonable como señal de anomalía, no como fricción operativa esperada.
- **Justificación**: una cuenta admin comprometida que intente escalar/cerrar períodos repetidamente debe ser detectable.
- **Auditoría**: obligatoria en `audit_log` sin excepción (ya es una regla no negociable del proyecto).

## 3. Consideraciones transversales

- **Almacenamiento distribuido**: si la app se despliega en múltiples instancias (serverless/edge), un contador en memoria local no sirve — se requiere un store compartido (Redis/Upstash u otro). Decisión de infraestructura futura, no tomada aquí.
- **Comportamiento ante caída del rate limiter**: debe decidirse explícitamente fail-open vs. fail-closed por tipo de operación (propuesta: fail-closed para login/acciones sensibles, fail-open tolerable para operaciones de solo lectura de bajo riesgo) — no implementado, no decidido.
- **Protección contra bypass**: el rate limiting nunca debe ser la única defensa (ver capas ya implementadas: RLS, guard de sesión, validación de contraseña de Supabase Auth); nunca confiar en un header de IP sin verificar la cadena de confianza del proxy que lo generó.
- **Encabezados confiables**: cualquier IP usada para limitar debe venir de una fuente verificada por la plataforma de hosting (no aceptar `X-Forwarded-For` arbitrario de un cliente no confiable) — mismo principio que Supabase exige para habilitar `Sb-Forwarded-For`.

## 4. Qué NO está implementado (recordatorio explícito)

Ningún límite de este documento existe en código. La única protección real hoy son los defaults de Supabase Auth **en el entorno local de desarrollo**, que no deben asumirse válidos para un proyecto de producción sin confirmarlos explícitamente contra el plan Supabase que se contrate.
