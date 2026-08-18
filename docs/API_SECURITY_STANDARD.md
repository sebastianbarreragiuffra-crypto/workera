# Estándar de Seguridad de API — obligatorio para toda futura ruta

Estado: creado en Gate C pre-UI. **Este documento no describe ninguna ruta existente** — hoy `src/app/api/` solo contiene `README.md`, cero `route.ts` reales (verificado). Es el checklist que cualquier futuro `route.ts`, Server Action con efectos de escritura, o endpoint debe cumplir antes de mergearse, sin excepción.

Ver también: `ARCHITECTURE.md`, `docs/THREAT_MODEL.md` (amenazas T-03, T-07, T-08, T-09, T-10, T-13, T-15, T-19), `docs/ABUSE_RATE_LIMITING_PLAN.md`.

## Principio secure-by-default

1. **Todo endpoint nuevo se considera privado por defecto.** Debe pasar por el guard de sesión (`src/proxy.ts` ya cubre `/api/*` → 401 si no hay sesión verificada) y, además, revalidar autorización específica del recurso dentro del propio handler — el guard de sesión NO es autorización de recurso, solo confirma identidad.
2. **Nunca confiar en inputs del cliente** — ni IDs, ni roles, ni flags de autorización enviados en el body/query. La identidad viene de `getClaims()`/la sesión; el rol viene de `profiles.role` leído server-side; la pertenencia (supervisor↔trabajador) se valida contra la base de datos, no contra lo que el cliente afirma.
3. **`service_role` solo en servidor**, y solo en el módulo específico que lo necesite (nunca reutilizado como cliente genérico) — ver `docs/THREAT_MODEL.md` T-06.
4. **Ninguna autorización depende de la UI.** Ocultar un botón no es control de acceso. RLS + validación server-side son la única autoridad.
5. **Ninguna ruta se aprueba sin tests** — positivos (acceso permitido) y negativos (acceso denegado, input inválido, rol incorrecto) como mínimo, siguiendo el patrón ya usado en `src/lib/workera/*.test.ts` y `src/lib/supabase/middleware.test.ts` (mocks, sin red real).

## Checklist obligatorio por endpoint

### Identidad y autorización
- [ ] Autenticación verificada con claims (`getClaims()`, ya cubierto por el guard global) — nunca reimplementar verificación de sesión dentro de la ruta.
- [ ] Autorización explícita por rol **y** por recurso (ej. "es `ADMIN_RRHH`" **y** "el trabajador pertenece a su grupo") — nunca solo uno de los dos.
- [ ] La query a Postgres se hace con el cliente que respeta RLS (`createClient()` de `src/lib/supabase/server.ts`), nunca con `service_role`, salvo un caso explícitamente justificado y documentado.

### Validación de entrada
- [ ] Todo el body/query se valida con **Zod**, siguiendo el patrón ya usado en `src/lib/workera/schemas/*.ts` (schema explícito, sin `any`).
- [ ] El schema define el contrato: **rechaza campos inesperados si el contrato lo exige** (a diferencia del adapter Workera, que deliberadamente usa `strip` para tolerar campos nuevos de una API externa — un endpoint propio, dueño de su propio contrato, sí puede y debe usar `.strict()` cuando el input viene de un cliente que la propia app controla).
- [ ] Métodos HTTP correctos: nunca mutar estado con `GET`; `POST`/`PATCH`/`DELETE` según semántica REST.
- [ ] `Content-Type` validado antes de parsear el body.
- [ ] Tamaño máximo del payload definido explícitamente (ver `docs/THREAT_MODEL.md` T-15) — responder `413` si se excede.
- [ ] Parsing seguro: nunca `eval`, nunca deserialización insegura; `JSON.parse` estándar con manejo de excepción.

### Superficie de ataque
- [ ] CSRF: las Server Actions de Next.js ya tienen protección nativa; los Route Handlers que reciban `POST` desde un formulario deben confirmar que no aceptan mutaciones cross-origin sin control.
- [ ] CORS: sin headers `Access-Control-Allow-Origin: *` en ningún endpoint que maneje datos autenticados; si se necesita CORS, allowlist explícita de orígenes.
- [ ] SSRF: si el endpoint hace una request saliente (ej. hacia Workera), la URL de destino nunca se construye a partir de input del cliente — ver `docs/THREAT_MODEL.md` T-10.
- [ ] Redirects: cualquier redirect construido por el servidor usa un destino interno fijo o una allowlist — nunca un parámetro de query sin validar (mismo criterio ya aplicado en el guard de sesión, que ignora cualquier `?next=`).
- [ ] Inyección: sin concatenación de SQL; si se necesita SQL dinámico, usar los mecanismos de parametrización de Postgres, nunca interpolación de strings.
- [ ] Archivos: validar tipo MIME real (no solo el declarado por el cliente) y tamaño antes de aceptar cualquier upload — ver `docs/THREAT_MODEL.md` T-13.

### Idempotencia y concurrencia
- [ ] Operaciones de escritura sensibles (aprobaciones, sync) son idempotentes — mismo patrón que `UNIQUE(source, external_id)` ya usado en `attendance_records`.
- [ ] Concurrencia: si dos requests pueden competir por el mismo recurso, usar transacciones/locks de Postgres apropiados, no asumir ejecución secuencial.

### Errores y observabilidad
- [ ] Mensajes de error genéricos hacia el cliente — nunca exponer stack trace, nombre de tabla, ni detalle interno (mismo criterio que `login/actions.ts`: "No pudimos iniciar sesión con esas credenciales", sin revelar si el email existe).
- [ ] Correlation ID por request, siguiendo el patrón de `createCorrelationId()` en `src/lib/workera/logging.ts`.
- [ ] Logging sin PII: nunca pathname con identificadores, query string, cookies, tokens, claims, email, payload completo — mismo criterio que el guard de sesión (`middleware.ts`, verificado por test).
- [ ] Rate limiting aplicado según `docs/ABUSE_RATE_LIMITING_PLAN.md` (cuando esté implementado — hoy es `PLANNED`, no bloqueante para diseñar el endpoint pero sí para exponerlo en producción).
- [ ] Timeouts explícitos en cualquier llamada saliente (ej. futuro `HttpWorkeraClient`, que ya tiene `requestTimeoutMs` diseñado en `config.ts`).
- [ ] Reintentos solo para errores clasificados como retryable (mismo criterio que `isRetryableWorkeraError()` en `errors.ts`).
- [ ] Caché: respuestas que contienen datos de sesión/personales nunca cacheadas por defecto (`Cache-Control: no-store` cuando aplique).
- [ ] Headers de seguridad estándar cuando aplique (`X-Content-Type-Options: nosniff`, etc.) — a definir con el framework de despliegue elegido.

### Códigos de respuesta
El endpoint debe responder con el código correcto según el caso, sin exponer detalle interno en el body:

| Código | Caso |
|---|---|
| `401` | Sin sesión verificada (ya cubierto globalmente por el guard, `middleware.ts`) |
| `403` | Sesión válida pero sin autorización para el recurso/acción |
| `404` | Recurso inexistente (o oculto deliberadamente si su existencia es sensible — evaluar caso a caso) |
| `409` | Conflicto de estado (ej. intentar aprobar algo ya decidido) |
| `413` | Payload/archivo excede el tamaño máximo |
| `415` | `Content-Type` no soportado |
| `422` | Payload bien formado pero inválido según el schema Zod |
| `429` | Rate limit excedido (cuando esté implementado) |
| `500` | Error interno — mensaje genérico, nunca detalle de la excepción |

### Tests obligatorios antes de aprobar la ruta
- [ ] Caso positivo: usuario autorizado, input válido → respuesta esperada.
- [ ] Caso negativo de autenticación: sin sesión → `401`.
- [ ] Caso negativo de autorización: sesión válida pero rol/recurso incorrecto → `403`.
- [ ] Caso negativo de validación: input inválido → `422`.
- [ ] Caso de idempotencia si aplica: misma operación repetida no duplica el efecto.
- [ ] Sin llamadas de red reales en el test (mismo patrón que `test:workera`/`test:auth`: mocks/fábricas inyectadas).

### Auditoría
- [ ] Toda escritura que modifique una decisión de negocio (aprobación, rechazo, corrección) queda registrada en `audit_log` con actor, acción y timestamp — sin excepción, siguiendo la regla ya declarada en `ARCHITECTURE.md` desde Fase 1.

## Qué NO afirma este documento

Este estándar no implica que exista ya ningún endpoint que lo cumpla — es el criterio de aceptación para cuando se construyan. No modificar este documento para reflejar excepciones sin registrar la decisión en `docs/DECISIONS_PENDING.md` primero.
