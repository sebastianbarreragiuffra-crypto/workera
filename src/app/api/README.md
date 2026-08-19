# app/api/

Route Handlers server-side de Next.js. Es la capa "Backend" del flujo `Frontend → Backend → Workera API`.

Endpoints previstos (se agregan fase a fase, no todos de una vez):
- `GET /api/sync/workera` — disparo del cron automático (Fase 6B). Autenticado vía `Authorization: Bearer $CRON_SECRET` (el header que Vercel Cron agrega automáticamente) — nunca sesión de usuario. Ver `docs/WORKERA_SYNC_PHASE6B.md`. **Cron NO desplegado/activado todavía** — infraestructura código-completa, `WORKERA_SYNC_ENABLED` sin activar en producción.
- `POST /api/sync/workera` — rerun administrativo manual de un rango acotado de días (Fase 6B). Requiere sesión SUPER_ADMIN o ADMIN_RRHH.
- `POST /api/overtime/approve` — aprueba/rechaza horas extra, valida server-side y escribe auditoría (Fase 7).
- `POST /api/workera/authorize-overtime` — reenvía la aprobación a Workera si su API lo permite (Fase 8).
- `POST /api/exports/weekly` — genera el Excel semanal (Fase 10).

Ningún Route Handler debe confiar en IDs o roles enviados por el cliente sin volver a validarlos contra la sesión de Supabase.
