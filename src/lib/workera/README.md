# workera/

Adaptador hacia la API de Workera. Se implementa en **Fase 4**.

Contendrá:
- `types.ts` — tipos compartidos (`Employee`, `Attendance`, `OvertimeRecord`, `Absence`, etc).
- `client.ts` — interfaz `WorkeraClient` (contrato estable).
- `mockClient.ts` — implementación con datos simulados (usada mientras no tengamos la documentación/API real confirmada).
- `httpClient.ts` — implementación real contra la API de Workera (Fase 4/5, una vez confirmados los endpoints).

**Regla de seguridad:** este módulo solo se importa desde código server-side (route handlers o Supabase Edge Functions). Nunca desde `"use client"` ni desde el browser. La API key de Workera vive únicamente en variables de entorno del servidor.
