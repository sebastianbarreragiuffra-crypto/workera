# Inventario de capacidades `service_role`

Estado: `IMPLEMENTED_LOCAL` para el inventario de consumidores; la separación
física de credenciales y la verificación de grants hospedados siguen pendientes.

`SUPABASE_SERVICE_ROLE_KEY` omite RLS y, por lo tanto, no se trata como un
cliente de datos general. La fuente de verdad auditable es
`src/lib/supabase/service-role-capabilities.ts`: `createAdminClient()` exige una
capacidad registrada y una prueba comprueba que cada identificador literal solo
aparezca en los archivos declarados.

## Capacidades actuales

| Capacidad | Proceso | Límite principal |
|---|---|---|
| `auth-user-provisioning` | Alta de cuentas humanas | APP_ADMIN autorizado con su sesión antes de Auth Admin |
| `company-invitation-delivery` | Entrega de invitaciones | Invitación autorizada y registrada antes del correo |
| `mfa-factor-administration` | Reseteo MFA de terceros | OWNER en `aal2` y `can_reset_mfa_for()` |
| `mfa-audit-log` | Bitácora MFA | Eventos tipados y tabla append-only |
| `workera-attendance-sync` | Sincronización de marcaciones | `CRON_SECRET` o rerun con rol autorizado; alcance por empresa |
| `attendance-rule-engine` | Derivación de asistencia | Cron o acción autorizada; fecha/empleado acotados |
| `expense-ocr-worker` | Cola OCR | `CRON_SECRET`, flag apagado por defecto y RPC fenced |
| `expense-receipt-storage` | Storage privado de comprobantes | Sesión/webhook validado y RPC tenant-aware |
| `expense-email-ingestion` | Webhook de correo | Firma, flag, alias, membresía, leases y cuotas |
| `expense-whatsapp-ingestion` | Webhook de WhatsApp | Firma, flag, número, vínculo HMAC, leases y cuotas |
| `expense-bank-import` | Importación bancaria | Sesión y permiso; RPC revalida actor/empresa |
| `expense-accounting-worker` | Outbox contable | `CRON_SECRET`, flag y RPC fenced sin tablas directas |
| `expense-assistant-retention` | Purga del asistente | `CRON_SECRET` y una única RPC de retención |

## Regla para cambios

Un consumidor nuevo no se habilita agregando simplemente otro directorio a una
allowlist. Debe:

1. vivir en un módulo `server-only` fuera de `src/app`;
2. declarar una capacidad en el registro con consumidor, entrada, autorización
   previa y recursos alcanzables;
3. mantener Route Handlers y Server Actions sin acceso directo a
   `createAdminClient`;
4. revalidar actor, empresa, permiso, estado e idempotencia dentro de una RPC
   allowlisted cuando la operación afecta datos tenant;
5. agregar pruebas negativas de autorización y aislamiento.

## Riesgo residual

El identificador de capacidad es un control de arquitectura y revisión, no una
frontera criptográfica: hoy varias capacidades comparten la misma llave. Antes
de producción todavía se debe verificar el conjunto real de grants en Supabase
hosted, rotar y custodiar el secreto, separar identidades/secretos por job cuando
la plataforma lo permita y probar el blast radius desde el ambiente hospedado.
