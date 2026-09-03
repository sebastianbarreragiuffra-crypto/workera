# Recepción de comprobantes por correo

Estado: **código completo, deshabilitado por defecto**. El canal no recibe
correos hasta configurar Resend y cambiar explícitamente el interruptor.

## Cómo funciona

1. Cada usuario activa una dirección opaca distinta por empresa desde
   **Rendiciones → Comprobantes**.
2. Resend recibe el correo y envía un evento `email.received` al webhook de la
   aplicación.
3. La aplicación limita el cuerpo a 512 KiB mientras llega y verifica la firma
   Svix sobre esos bytes crudos antes de interpretar el evento. El campo `From`
   nunca decide la identidad ni la empresa.
4. El token del destinatario se resuelve en PostgreSQL solo mediante una
   función `service_role`, que revalida membresía, módulo y permisos activos.
5. Antes de llamar a Resend se reclama el evento en un ledger durable y se
   reserva su cupo de bandeja. Cada lease emite un token de intento: un worker
   antiguo no puede registrar, completar ni liberar una lease renovada.
6. Los adjuntos se consultan con la API de Resend y se descargan únicamente
   desde `https://inbound-cdn.resend.com`, sin redirecciones.
7. Solo se aceptan PDF, JPG y PNG de hasta 10 MiB cuya firma binaria coincide
   con su MIME. Se procesan como máximo 10 adjuntos explícitos por correo; el
   cuerpo y las imágenes inline se ignoran.
8. Cada par correo/adjunto tiene una clave SHA-256 idempotente. Un reintento del
   webhook devuelve la captura existente y no duplica archivos ni consume otro
   espacio de la bandeja.

Los errores de red, rate limit o proveedor responden 5xx para que Resend vuelva
a entregar el evento. Si una URL temporal expiró, se solicita una URL nueva y
se intenta nuevamente; los archivos definitivamente inválidos sí se ignoran.
Aunque se ignoren, sus eventos, adjuntos y bytes permanecen contabilizados en
una ventana horaria: máximo 20 correos nuevos, 50 adjuntos y 100 MiB por
persona/empresa. Al superar esa cuota no se consulta ni descarga más contenido.
Los correos vacíos, inline o con formatos no admitidos también consumen el
límite de eventos, aunque se cierran sin consultar la API de adjuntos.
Cada reintento obtiene una lease nueva y vuelve a cargar sus descargas a la
ventana vigente; nunca reutiliza gratis los bytes de un intento fallido.

La dirección es una capacidad secreta. El usuario puede reemplazarla en la
misma pantalla; el token anterior deja de resolver inmediatamente. Tampoco se
registran remitentes, destinatarios, URLs firmadas ni secretos en logs.

## Configuración de Resend

Documentación oficial de referencia:

- [Receiving emails](https://resend.com/docs/dashboard/receiving/introduction)
- [Verifying webhook requests](https://resend.com/docs/webhooks/verify-webhooks-requests)
- [Processing attachments](https://resend.com/docs/dashboard/receiving/attachments)

En el entorno donde se despliega la aplicación:

```text
EXPENSE_EMAIL_CAPTURE_ENABLED=false
RESEND_API_KEY=<API key server-side>
RESEND_WEBHOOK_SECRET=<signing secret whsec_...>
RESEND_RECEIVING_DOMAIN=<hostname verificado, sin https ni ruta>
```

En Resend se debe verificar el dominio receptor y crear un webhook con:

```text
https://<dominio-de-la-app>/api/webhooks/resend/expense-receipts
```

El webhook debe suscribirse únicamente a `email.received`. Primero se prueba
con `EXPENSE_EMAIL_CAPTURE_ENABLED=false`; después de verificar dominio,
secreto y URL, se cambia exactamente a `true`. Cualquier otro valor mantiene
el endpoint cerrado con HTTP 503.

## Controles operacionales

- No reutilizar `CRON_SECRET`, claves de Supabase ni credenciales de Workera.
- Las variables son server-side; nunca deben tener prefijo `NEXT_PUBLIC_`.
- No pegar secretos en tickets, chats, documentación ni commits.
- Si una dirección se publica o recibe spam, usar **Reemplazar dirección**.
- Mantener la bandeja bajo 50 pendientes; al alcanzar el límite no entran
  capturas nuevas hasta liberar espacio.
- Revisar en Resend los reintentos fallidos antes de reproducir manualmente un
  evento; el ledger hace segura la reproducción, pero no debe usarse como cola.
- WhatsApp no forma parte de este bloque y continúa deshabilitado.
