<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- Todo lo que sigue está FUERA del bloque que regenera `next dev`
     (marcadores BEGIN/END arriba), así que se conserva. -->

# Trabajo en paralelo sobre este repositorio

Acá trabaja más de un agente a la vez, en varios `git worktree` del mismo
repositorio y sobre una única instancia local de Supabase. Cada una de estas
reglas existe porque su ausencia ya causó un problema real.

## 1. Empezar sincronizado

```bash
git fetch origin && git log --oneline -1 origin/master
```

Si tu rama está más de ~5 commits detrás de `master`, rebasa **antes** de
escribir código. Ha habido ramas 13 y 30 commits atrás, construyendo sobre
versiones viejas de archivos que ya habían cambiado.

## 2. Nunca terminar con trabajo sin commitear

Al cerrar una sesión, `git status` debe quedar limpio. Si el trabajo no está
listo, va igual a una rama `wip/` y se empuja. El trabajo sin commitear existe
en un solo disco: no viaja entre computadores y no lo ve nadie más.

## 3. Migraciones: revisar el último timestamp antes de crear una

```bash
ls supabase/migrations | tail -3
ls supabase/tests | tail -3
```

El timestamp nuevo debe ser **posterior** al último, y el número de test debe
continuar la secuencia. Una migración con fecha "del pasado" se aplica bien en
local, porque ahí se ordenan por nombre, y queda sin aplicar en staging, donde
las posteriores ya corrieron. Es un error que no se manifiesta donde se comete.

## 4. La base local es compartida entre worktrees

`project_id` está versionado, así que todos los worktrees usan los mismos
contenedores. No ejecutar `npx supabase db reset` sin aislar antes el worktree
— procedimiento en [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).

Si `npx supabase test db` falla de forma inexplicable, descartar el entorno
**antes** que el código:

```bash
docker exec supabase_db_Workera psql -U postgres -d postgres \
  -tAc "select version from supabase_migrations.schema_migrations order by version desc limit 5;"
ls supabase/migrations | tail -5
```

Si no coinciden, la base quedó con las migraciones de otra rama y el resultado
de los tests no significa nada.

## 5. Al resolver un conflicto, leer por qué existe el otro lado

```bash
git log -1 --format=%B <commit-que-tocó-ese-archivo>
```

No descartar un cambio ajeno sin entenderlo. Varias correcciones de seguridad
de este repositorio se ven inocuas en el diff: una validación de UUID que
parece defensiva evitaba inyección en un header HTTP, y un tipo de error que
parece ceremonia evitaba filtrar mensajes internos de PostgREST al cliente.

## 6. No afirmar que algo funciona sin haberlo corrido

```bash
npx tsc --noEmit && npm run lint && npm test && npm run build
npx supabase test db   # solo con la instancia local aislada (ver regla 4)
```

Pegar el resultado real. Si un gate no se corrió, decirlo explícitamente. Esto
extiende la regla de la sección 8 de
[docs/PLATFORM_MULTI_COMPANY.md](docs/PLATFORM_MULTI_COMPANY.md): toda
afirmación de funcionalidad o prueba debe corresponder al estado real del
repositorio.

## Lo que estas reglas NO resuelven

Reducen los choques; no los eliminan. Dos agentes editando el mismo archivo a
la vez van a chocar igual. Lo que elimina la clase entera de problema es
repartir dominios distintos — por ejemplo, uno en Rendiciones y otro en
asistencia — en vez de dejar que ambos toquen cualquier cosa. Estas reglas son
la red de seguridad, no el plan.
