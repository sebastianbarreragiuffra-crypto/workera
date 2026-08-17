# Arquitectura — Workera Supervisor App

Estado: **Fase 1**. Este documento se actualiza fase a fase; no describe funcionalidad todavía implementada más allá del scaffold base.

## 1. Objetivo

Web app responsive para que supervisores revisen diariamente la asistencia/horas extra de sus trabajadores (datos importados de Workera) y aprueben/rechacen decisiones, dejando auditoría completa y generando un Excel semanal para remuneraciones.

## 2. Diagrama de flujo

```
┌─────────────────────┐
│  Supervisor/Admin    │
│  (browser, celular    │
│   o desktop)          │
└──────────┬───────────┘
           │ HTTPS (sesión Supabase Auth)
           ▼
┌─────────────────────────────────────┐
│ Next.js Frontend (Vercel)            │
│  - Client Components (UI, dashboard) │
│  - Lee/escribe Postgres vía          │
│    supabase-js (respetando RLS)      │
└──────────┬────────────────────────────┘
           │ solo para operaciones que requieren
           │ lógica server-side o secretos
           ▼
┌─────────────────────────────────────┐
│ Next.js Route Handlers (server-only) │
│  src/app/api/*                       │
│  - Validan sesión + rol server-side  │
│  - Nunca confían en IDs del cliente  │
└───────┬───────────────────┬──────────┘
        │                   │
        ▼                   ▼
┌───────────────┐   ┌─────────────────────────┐
│ Supabase       │   │ WorkeraClient (adapter) │
│ Postgres + RLS │   │  src/lib/workera/*      │
│ + audit_logs   │   │  - mock (Fase 4)        │
└───────────────┘   │  - real (Fase 4/5+)      │
                     └────────────┬─────────────┘
                                  │ HTTPS + API key
                                  │ (env var, server-only)
                                  ▼
                        ┌───────────────────┐
                        │   Workera API      │
                        └───────────────────┘
```

**Regla no negociable:** `Frontend → Backend → Workera`. El frontend nunca importa `src/lib/workera/*` ni conoce `WORKERA_API_KEY`. Esa clave solo existe como variable de entorno del servidor (Route Handlers) y nunca lleva el prefijo `NEXT_PUBLIC_`.

## 3. Por qué Route Handlers de Next.js en vez de (o adicional a) Supabase Edge Functions

El pedido original deja abierto "Edge Functions o backend server-side". Se elige **Route Handlers de Next.js** como capa principal para Fase 1-8 porque:

- Un solo repo y un solo deploy (Vercel) reduce complejidad operativa mientras el equipo es chico.
- El patrón adaptador (`WorkeraClient`) aísla la lógica de integración: si más adelante conviene mover la sincronización a una Supabase Edge Function (por ejemplo, para correr con cron nativo de Supabase sin depender de Vercel Cron), se mueve el *caller*, no la lógica del cliente Workera.
- Cron: Vercel Cron Jobs puede disparar `POST /api/sync/workera` diariamente. Si se prefiere que corra dentro de la infraestructura de Supabase, se migra en Fase 5 sin tocar el resto.

Esto se revisita explícitamente al inicio de Fase 5 (Sincronización).

## 4. Límites de seguridad (resumen; detalle en cada fase)

- **Secretos**: `WORKERA_API_KEY` y `SUPABASE_SERVICE_ROLE_KEY` solo en variables de entorno server-side (Vercel project settings), nunca en código ni en `NEXT_PUBLIC_*`.
- **RLS**: toda tabla con datos de trabajadores tiene Row Level Security activa desde su creación (Fase 2/3). Un supervisor solo puede leer filas de trabajadores vinculados a él en `employee_supervisors`.
- **Validación server-side**: los Route Handlers vuelven a validar rol y pertenencia (supervisor↔trabajador) contra la sesión, sin confiar en ningún ID enviado por el cliente.
- **Idempotencia**: la sincronización con Workera usa el ID externo de Workera como clave de upsert, nunca inserta ciegamente (Fase 2/5).
- **Auditoría**: ninguna escritura de aprobación/rechazo/corrección ocurre sin un registro correspondiente en `audit_logs`, incluyendo el valor anterior cuando se modifica algo ya aprobado (Fase 7/11).

## 5. Estructura de carpetas (creada en Fase 1)

```
src/
  app/
    api/            Route Handlers (backend). Ver src/app/api/README.md
    (rutas de UI se agregan desde Fase 6 en adelante)
  components/       UI compartida (Fase 6+)
  lib/
    supabase/       Clientes browser/server de Supabase (Fase 3)
    workera/        WorkeraClient: interfaz + mock + implementación real (Fase 4)
    excel/          Generación del Excel semanal con ExcelJS (Fase 10)
    auth/           Helpers de sesión/rol (Fase 3)
supabase/           Migraciones SQL y Edge Functions si aplica (Fase 2+)
```

Cada carpeta tiene un `README.md` explicando qué va ahí y en qué fase se completa, para que el árbol del proyecto sea legible incluso vacío.

## 6. Decisiones pendientes de Fase 1 en adelante

- **Fase 2**: esquema definitivo de tablas — se propondrá analizando los requisitos, no copiando un esquema genérico.
- **Fase 4/5**: confirmar con documentación real de Workera si hay webhooks o solo polling, y si el cálculo de horas extra lo hace Workera o debe derivarse de marcaciones vs. jornada.
- **Fase 10**: mapeo exacto de columnas/celdas contra la plantilla `.xlsx` real de la empresa (pendiente de que la compartas).
