# supabase/

Clientes de Supabase. Se implementan en **Fase 3 (Autenticación y roles)**.

- `client.ts` — cliente browser (usa `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`). Respeta RLS, es lo único que el frontend usa directamente.
- `server.ts` — cliente server-side (route handlers / server components). Puede usar `SUPABASE_SERVICE_ROLE_KEY` cuando una operación necesita saltarse RLS de forma controlada (ej. la sincronización con Workera escribe como "sistema"). **Nunca se importa desde un componente cliente.**
- `database.types.ts` — **ya existe** (Fase 2). Tipos generados desde el esquema real con `supabase gen types typescript --local`. Regenerar después de cada migración nueva; no editar a mano.
