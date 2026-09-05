# Desarrollo local de Workera en varios computadores

Esta guía define una sola configuración reproducible para PC1, PC2 y cualquier
equipo nuevo. Cada computador mantiene su propia base Docker; staging sigue
siendo el único ambiente remoto compartido.

## Qué se comparte y qué permanece local

| Archivo | Se versiona | Uso |
|---|---:|---|
| `supabase/config.toml` | Sí | Puertos, Auth y servicios de la pila local de Workera |
| `supabase/migrations/` | Sí | Esquema y controles de seguridad |
| `.env.example` | Sí | Plantilla sin secretos y URL local canónica |
| `.env` | No | Variables que Supabase CLI resuelve desde `config.toml`, incluido Google OAuth |
| `.env.local` | No | URL y claves locales que consume la aplicación Next.js |
| `.env.staging` | No | Credenciales del proyecto remoto compartido |

No se deben copiar archivos `.env` entre computadores ni enviarlos por chat.
Cada persona obtiene sus valores localmente o por el canal privado autorizado.

## Puertos locales canónicos

Los puertos pertenecen al proyecto, no al computador. PC1 y PC2 pueden usar
los mismos valores porque cada pila escucha en una máquina diferente.

| Servicio | Puerto / URL |
|---|---|
| API y Auth | `http://127.0.0.1:54421` |
| PostgreSQL | `54422` |
| Studio | `http://127.0.0.1:54423` |
| Mailpit | `http://127.0.0.1:54424` |
| Analytics | `54427` |
| Pooler | `54429` |
| Shadow database | `54420` |
| Inspector de Edge Functions | `8093` |

El rango `5442x` evita colisionar con otros proyectos que usan los puertos
predeterminados `5432x`. Si existe una colisión real, no se edita
`config.toml` solo en ese PC: se acuerda un rango nuevo y se versiona para el
equipo completo.

## Varios worktrees en el mismo computador

La regla anterior asume una pila por máquina. No cubre el caso de tener
varios `git worktree` del repositorio abiertos a la vez, que es lo habitual
cuando trabaja más de un agente en paralelo.

**Todos los worktrees comparten la MISMA instancia local de Supabase**, porque
`project_id` determina el nombre de los contenedores y está versionado. Las
consecuencias son concretas y ya ocurrieron:

- Un `npx supabase db reset` hecho desde un worktree aplica **las migraciones
  de esa rama** a la base que usan todos los demás.
- A partir de ahí, `npx supabase test db` en otro worktree corre los tests de
  su rama contra un esquema ajeno. Falla —o pasa— por razones que no tienen
  relación con el código que se está probando.
- Los síntomas engañan: tablas que "desaparecen", corridas que pasan de 10
  segundos a 10 minutos, y fallos de RLS en `storage.objects` que parecen
  defectos reales y no lo son.

**Cómo verificar antes de dudar del código.** Si `supabase test db` falla de
forma inexplicable, comparar lo aplicado en la base contra las migraciones de
la rama actual:

```bash
docker exec supabase_db_Workera psql -U postgres -d postgres \
  -tAc "select version from supabase_migrations.schema_migrations order by version desc limit 5;"
ls supabase/migrations | tail -5
```

Si no coinciden, la base es de otra rama y el resultado de los tests no
significa nada.

CI además compara cada migración agregada con el último timestamp de la rama
base. Una versión tardía, duplicada o sin nombre canónico se rechaza antes de
levantar Supabase; este control complementa, pero no reemplaza, revisar los tres
últimos archivos antes de crear una migración.

**Cómo aislar un worktree.** En su `supabase/config.toml`, darle un
`project_id` propio y desplazar todo el rango de puertos:

```toml
project_id = "workera-<nombre-del-worktree>"
# 5442x -> 5642x en api.port, db.port, db.shadow_port, db.pooler.port,
# studio.port, inbucket.port y analytics.port
```

Ese cambio es **deliberadamente local y no se commitea**: subirlo movería los
puertos de todo el equipo. Queda como archivo modificado permanente en ese
worktree, así que conviene no usar `git add -A` a ciegas ahí, y revisar que
`config.toml` no se cuele en un commit.

## Preparación inicial en cada PC

1. Instalar Docker Desktop, Node.js y Supabase CLI.
2. Clonar el repositorio y restaurar las dependencias del proyecto.
3. Copiar `.env.example` a `.env` y a `.env.local`.
4. En `.env`, completar únicamente los valores locales que necesita Supabase
   CLI, incluidas las credenciales Google si se probará OAuth.
5. Iniciar Supabase y copiar desde su salida la clave pública local y la clave
   de servicio a `.env.local`. La URL ya debe ser
   `http://127.0.0.1:54421`.
6. Iniciar la aplicación y abrirla con
   `http://127.0.0.1:3000` o `http://localhost:3000`.

No se debe ejecutar un reset local para corregir puertos o callbacks. Los
cambios de `config.toml` se toman al reiniciar la pila local y no alteran el
esquema remoto.

## Google OAuth local

Google debe autorizar:

- Orígenes JavaScript: `http://127.0.0.1:3000` y
  `http://localhost:3000`.
- Callback de Supabase local:
  `http://127.0.0.1:54421/auth/v1/callback`.

Supabase, a su vez, permite que el flujo PKCE vuelva a
`/auth/callback` usando cualquiera de los dos hostnames locales. Los detalles
y la configuración de producción están en `docs/AUTH_GOOGLE_OAUTH.md`.

## Trabajo diario y staging

- Desarrollo habitual: Docker local + `.env.local`.
- Prueba compartida: iniciar la aplicación con `.env.staging` sin modificar
  `supabase/config.toml`.
- Migraciones locales: aplicar solo contra la pila local.
- Staging: nunca ejecutar un reset; seguir `docs/STAGING_ENVIRONMENT.md`.

Antes de subir cambios, comprobar que no se versionó ningún `.env` y que
`supabase/config.toml` solo contiene configuración compartida, nunca secretos.
