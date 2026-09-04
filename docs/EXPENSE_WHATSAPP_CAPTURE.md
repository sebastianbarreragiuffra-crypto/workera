# Captura de comprobantes por WhatsApp

## Estado y alcance

Este canal recibe fotografías o documentos PDF/JPG/PNG mediante WhatsApp Cloud
API y los deja en la misma bandeja privada de comprobantes de Rendiciones. Está
**deshabilitado por defecto** y no debe activarse hasta terminar la configuración
de Meta y una prueba controlada en staging.

La aplicación no guarda el número ni el `wa_id` real. Conserva únicamente un
HMAC-SHA256 calculado con `WHATSAPP_LINK_SECRET`. Tampoco guarda el texto del
mensaje ni la URL temporal del archivo.

## Flujo para la persona usuaria

1. En Rendiciones → Comprobantes, elegir **Generar código de vinculación**.
2. La aplicación muestra un código aleatorio que vence en 10 minutos y un enlace
   al número empresarial.
3. Enviar por WhatsApp el texto `VINCULAR <código>`.
4. Desde ese momento, las fotos y documentos compatibles enviados desde ese
   número llegan a la bandeja personal de la empresa seleccionada.
5. La vinculación se puede revocar desde la misma pantalla. Si la membresía, el
   módulo o los permisos dejan de estar vigentes, la recepción se corta de
   inmediato aunque el vínculo todavía exista.

Un número solo puede estar vinculado a una persona y empresa a la vez. Vincularlo
de nuevo reemplaza el vínculo anterior para evitar asignaciones ambiguas.

## Configuración en Meta y en el entorno

Crear o seleccionar una app de Meta con WhatsApp Cloud API y configurar el
webhook HTTPS público:

`https://<dominio-staging>/api/webhooks/meta/expense-receipts`

El endpoint acepta la verificación GET de Meta y los eventos POST firmados.
Suscribir el campo `messages` y usar en Meta el mismo valor aleatorio de
`WHATSAPP_VERIFY_TOKEN`.

Configurar exclusivamente como secretos server-side:

- `WHATSAPP_APP_SECRET`: secreto de la app de Meta, usado para verificar
  `X-Hub-Signature-256` sobre el cuerpo crudo.
- `WHATSAPP_VERIFY_TOKEN`: secreto independiente para el desafío inicial.
- `WHATSAPP_ACCESS_TOKEN`: token server-side para consultar y descargar media.
- `WHATSAPP_PHONE_NUMBER_ID`: identificador numérico del número autorizado.
- `WHATSAPP_BUSINESS_NUMBER`: número público con código de país, usado solo para
  construir el enlace `wa.me`.
- `WHATSAPP_GRAPH_API_VERSION`: versión explícita vigente configurada en Meta.
- `WHATSAPP_LINK_SECRET`: secreto aleatorio independiente, de al menos 32 bytes,
  para anonimizar el remitente. Rotarlo invalida todas las vinculaciones.
- `WHATSAPP_MEDIA_HOSTS`: lista separada por comas de hostnames HTTPS exactos que
  Meta entrega para las descargas de media. No incluir protocolo ni rutas.
- `EXPENSE_WHATSAPP_CAPTURE_ENABLED`: mantener `false` hasta el último paso.

No usar el prefijo `NEXT_PUBLIC_` y no reutilizar secretos de Supabase, Workera,
cron, Resend ni Meta entre campos.

## Despliegue controlado

1. Aplicar la migración `20260904170000_expense_receipt_whatsapp_capture.sql`.
2. Configurar todos los secretos con el interruptor todavía en `false`.
3. Publicar la aplicación y registrar/verificar el callback en Meta.
4. Activar temporalmente el canal para un usuario piloto de staging.
5. Vincular el número, enviar una foto y confirmar que aparece solo en la bandeja
   correcta; repetir el evento y confirmar que no crea duplicados.
6. Revocar el vínculo y confirmar que nuevos archivos ya no ingresan.
7. Solo después de esas comprobaciones dejar
   `EXPENSE_WHATSAPP_CAPTURE_ENABLED=true` para el grupo piloto.

## Controles incorporados

- firma HMAC obligatoria y cuerpo máximo de webhook de 512 KiB;
- código de vinculación aleatorio, de un solo uso y con expiración;
- comprobación en tiempo real de empresa, membresía, módulo y permisos;
- ledger idempotente con lease y token de fencing para reintentos;
- máximo de 60 eventos y 100 MiB por persona/empresa/hora;
- máximo compartido de 50 comprobantes pendientes en la bandeja;
- descargas HTTPS a hostnames exactos, sin redirecciones y con timeout;
- máximo de 10 MiB y validación de MIME y firma binaria;
- Storage privado y rutas que incluyen empresa y usuario;
- respuestas y comentarios sin números, contenidos, tokens ni URLs temporales.

Los errores transitorios responden 5xx para conservar el reintento del proveedor.
Los tipos no compatibles o mensajes sin vínculo se aceptan y se ignoran sin
exponer información sobre usuarios existentes.
