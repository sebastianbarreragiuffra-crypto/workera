# Ambiente compartido de staging — arcotex-workera-staging

> **SECURITY HOLD — NO-GO para nuevas pruebas con PII o conectores reales.** Este
> proyecto contiene 97 registros de empleados y no existe evidencia de que estén
> anonimizados. Tampoco están cerrados MFA/AAL2 integral, antimalware, backup y
> restauración DB+Storage, blast radius de `service_role`, incident response ni el
> paquete legal/privacidad. Hasta sanearlo con datos sintéticos/minimizados o aplicar
> controles equivalentes a producción, limitar acceso, mantener conectores apagados
> y no cargar documentos, cartolas o nueva información laboral real. Ver
> `docs/THREAT_MODEL_CURRENT.md` y `docs/TARGET_ARCHITECTURE_PHASES_2_6.md`.

Proyecto Supabase Cloud creado para que PC1 y PC2 prueben contra la misma base de datos, sin perder el Docker local de cada uno para desarrollo diario. Contexto completo: `ARCOTEX_SHARED_ENVIRONMENT_PLAN_READY` y `STAGING_DATA_MIGRATION_PLAN`.

## Estado del proyecto

- **Nombre**: `arcotex-workera-staging`
- **Organización**: Arcotex DEV
- **Región**: `sa-east-1` (São Paulo)
- **Ref**: ver tu `.env.staging` local (nunca en este doc — este archivo se sube a Git)
- **Migraciones remotas verificadas**: aplicadas hasta `20260902170000`,
  comprobado con `npx supabase db push --dry-run --linked` el 4 de septiembre
  de 2026. La cifra anterior de este documento, 59 hasta `20260901180000`,
  había quedado desactualizada. El dry run no escribe nada y es la única forma
  confiable de saber dónde está staging: vuelve a correrlo antes de cualquier
  despliegue en vez de creerle a esta línea.
- **Pendiente de master**: cinco migraciones, `20260903100000` y las cuatro de
  MFA, de `20260903140000` a `20260904160000`.
- **Pendiente de `codex/phases2-6-autonomous`**: diez migraciones,
  `20260903100000` y de `20260904170000` en adelante.

> **Orden entre ramas: master va primero.** Las cinco migraciones de master son
> todas anteriores a las diez de la rama de contabilidad de Rendiciones. Si esas
> diez se empujan primero, las de master quedan con fecha del pasado y ya no
> aplican en orden. Es el mismo error que describe la regla 3 de `AGENTS.md`,
> pero entre dos ramas en vez de dentro de una, y no se manifiesta en local
> porque ahí las migraciones se ordenan por nombre y se aplican todas. Lo más
> limpio es rebasar esa rama sobre master y hacer un solo push desde ahí.
- **Datos maestros**: 97 registros de empleados presentes en staging al cierre
  de la Fase 1. La depuración de posibles duplicados es una tarea de datos y no
  forma parte del despliegue estructural.

## Cómo trabaja PC1 (o cualquiera, día a día)

1. Desarrollo normal: `npm run dev` sigue usando `.env.local` → tu Docker local. Sin cambios, sin fricción, puedes resetear tu Docker cuando quieras sin afectar a nadie.
2. Cuando necesites ver/probar algo contra el ambiente compartido (staging):
   - Copia `.env.staging.example` a `.env.staging` si todavía no lo tienes.
   - Pide las credenciales reales del proyecto a quien lo administre (Project Settings → API en el dashboard de Supabase) — nunca se pegan en el chat ni en un commit.
   - Corre la app apuntando a ese archivo en vez de `.env.local` (por ejemplo, renombrando temporalmente, o con una herramienta como `dotenv-cli`: `dotenv -e .env.staging -- npm run dev`).
3. Vuelve a `.env.local` para seguir con desarrollo normal.

## Cómo trabaja PC2 (o cualquier nuevo colaborador)

1. Clona el repo, corre `supabase start` para su propio Docker local — sigue siendo su ambiente principal de desarrollo, igual que PC1.
2. Para staging: mismo procedimiento que PC1 — copiar `.env.staging.example`, pedir credenciales reales por un canal privado (no por Git, no por chat público), completar `.env.staging`.
3. Iniciar sesión en staging con su propia cuenta de `authorized_email_roles` (Google OAuth o email/password) — el primer login crea su `profile` automáticamente, con el rol que le corresponde según esa tabla.
4. **No correr `supabase db reset` contra staging** — ese comando es solo para el Docker local de cada quien. Contra staging, los cambios de esquema se hacen con `supabase db push` desde una rama/PR revisada, nunca con un reset destructivo.

## Reglas del ambiente compartido

- **Nunca** insertar empleados, proveedores, licencias o documentos directamente por SQL en staging — siempre por los importadores ya existentes (Licencias → Actualizar roster; Nómina de Pago → maestro de proveedores).
- **Nunca** copiar la tabla `profiles` entre proyectos — se recrea con un login real por persona (ver `STAGING_DATA_MIGRATION_PLAN`, sección "caso especial").
- Antes de correr un importador o aprobar/rechazar algo de prueba en staging, avisar al equipo — es una base compartida, no hay aislamiento entre lo que hace PC1 y lo que ve PC2.
- `.env.staging` (con valores reales) nunca se commitea — está en `.gitignore` igual que `.env.local`. Solo `.env.staging.example` (sin secretos) viaja con el repo.

## Checklist de verificación estructural (ya ejecutada en la creación)

- [x] Las 83 migraciones conciliadas hasta `20260902170000`
- [x] Rendiciones EX-1 a EX-8, EX-13 p1 y Fase 2 bloques 1-3 desplegados en staging
- [x] 83 tablas en `public`; 82 usan RLS y la tabla de catálogo global conserva su tratamiento explícito
- [x] 157 policies RLS y 71 triggers verificados en staging
- [x] 4 buckets de Storage presentes
- [x] `authorized_email_roles` con las 7 filas correctas (1 SUPER_ADMIN, 4 ADMIN_RRHH, 1 SUPERVISOR_PRODUCTION, 1 SUPERVISOR_INSTALLATION)
- [x] Trigger `on_auth_user_created` presente y habilitado sobre `auth.users`, función `handle_new_auth_user()` referencia `authorized_email_roles` y crea el `profile` correcto
- [x] Login real de una persona autorizada realizado
- [x] Roster importado vía la aplicación (97 registros presentes al cierre; revisar duplicados por separado)

## Cierre de Fase 1 — 3 de septiembre de 2026

Antes del despliegue se guardó un respaldo lógico de los esquemas `public`
y `storage` fuera del repositorio. La primera aplicación detectó correctamente
que el trigger de inmutabilidad impedía completar el `company_id` de las
marcaciones históricas de Workera. La migración se corrigió y se ensayó desde
un estado anterior con datos históricos antes de reintentar staging.

Validación final:

- las 80 migraciones locales y remotas coinciden;
- `supabase db lint --linked` no informa errores;
- las ocho comprobaciones remotas de aislamiento por empresa pasan;
- ninguna marcación Workera quedó sin empresa ni asociada a otra empresa;
- el trigger de inmutabilidad quedó activo;
- Rendiciones es el único módulo declarado `tenant_isolated`;
- la compilación de producción contra staging finaliza correctamente;
- `/login` responde, las rutas privadas redirigen al login sin sesión y el
  endpoint de sincronización rechaza llamadas sin credenciales.

## Fase 2, bloque 3 en staging — 3 de septiembre de 2026

Antes del despliegue de la recepción por correo se guardaron respaldos lógicos
de esquema y datos fuera del repositorio, en
`C:\Users\SEBAS\Desktop\workera-staging-backups\pre-phase2-email-e5df877`.
La simulación mostró únicamente la migración `20260902170000`; luego se aplicó
y se verificó que local/remoto coinciden, el dry-run quedó sin pendientes y el
lint remoto de `public`/`private` no informa errores.

El conector real permanece deshabilitado. No se configuraron API key, secreto
de webhook ni dominio receptor en staging. Verificar dominio y webhook en Resend
es necesario, pero **no autoriza activarlo**: el SECURITY HOLD inicial debe estar
cerrado, los gates P0 aprobados y la habilitación registrada por los owners de
Security/Privacy/Expenses. Después se sigue `docs/EXPENSE_EMAIL_CAPTURE.md`.

## Nota de seguridad encontrada durante la creación

Supabase Cloud aplica, a nivel de plataforma, `ALTER DEFAULT PRIVILEGES` más permisivos que los que quedan en el Docker local para el rol `service_role` (en local, `service_role` tiene explícitamente denegado UPDATE/DELETE en la mayoría de las tablas — un endurecimiento deliberado de este proyecto, más allá de lo estándar de Supabase). En staging, `service_role` tiene el set completo de privilegios, igual que el comportamiento por defecto de cualquier proyecto Supabase nuevo.

El conteo histórico de ese momento fue 47 tablas/94 policies; **no es evidencia
vigente**. El inventario estructural más reciente es el indicado arriba
(83 tablas, 82 con RLS y 157 policies) y aun así debe repetirse con canarios
hosted por rol antes de levantar el hold. `service_role` nunca se expone al
cliente en este código (`admin-client.ts` es server-only), pero bypassea RLS y
en staging conserva privilegios amplios: el riesgo y blast radius son
**altos/no aceptados**, no opcionales. Se requiere inventario de usos, grants
mínimos, secretos separados y pruebas cloud antes de usar PII o conectores.
