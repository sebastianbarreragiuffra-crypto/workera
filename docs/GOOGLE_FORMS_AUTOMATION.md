# Automatización de Google Forms para colaciones

Cada carga válida de un menú Word crea un Google Form en la cuenta propietaria del Apps Script. El formulario recopila correo, permite elegir nombre y apellido desde la nómina activa existente, y agrega una pregunta obligatoria por cada día hábil detectado. Los días marcados como feriados se omiten.

## Seguridad y operación

- La app autoriza cada solicitud con un secreto guardado únicamente en variables de entorno y en Script Properties.
- El hash del Word y del cierre funciona como clave de idempotencia: repetir la misma carga reutiliza el formulario existente.
- El endpoint rechaza payloads sin autorización y limita el formulario a un máximo de cinco días.
- Un disparador revisa cada 15 minutos los formularios vencidos y deja de aceptar respuestas.
- La fecha no se solicita en el dashboard: el cierre se calcula automáticamente para el viernes a las 13:00, usando la hora de Chile. Una carga realizada después de ese horario se programa para el viernes siguiente.
- Google también crea una planilla de respuestas vinculada a cada formulario.
- El dashboard recupera desde Apps Script los últimos formularios creados, por lo que sus enlaces continúan disponibles después de recargar o volver a iniciar sesión.
- El dashboard consulta el estado del formulario activo y recibe únicamente los nombres declarados en las respuestas. No expone correos ni las elecciones de menú para calcular pendientes.
- Los nombres respondidos se comparan con la tabla existente de empleados activos. No se crea una nómina paralela ni se agregan teléfonos.
- Los formularios nuevos muestran esa nómina como una lista de selección para evitar falsos pendientes por abreviaciones o errores al escribir el nombre.
- Al crear el formulario, RRHH configura cuántas horas deben pasar antes de habilitar el recordatorio manual.
- `Copiar recordatorio WhatsApp` genera el texto con los trabajadores pendientes y el enlace real del formulario, y lo copia al portapapeles. La aplicación no abre WhatsApp, no envía mensajes y no integra APIs, bots ni servicios externos de mensajería.
- La planilla queda preparada como `Pedidos proveedor`: fecha y correo permanecen en las columnas A y B, pero están ocultas; la vista visible comienza con `Nombre y apellido` y continúa con los días hábiles del formulario.
- Cada registro del dashboard incluye una descarga directa en Excel (`.xlsx`) para enviarla al proveedor.

## Permisos

- Solo `SUPER_ADMIN` y `ADMIN_RRHH` pueden abrir el dashboard, crear formularios, consultar estadísticas, ver pendientes y generar el recordatorio.
- Los trabajadores reciben únicamente el enlace público de respuesta que RRHH comparte manualmente en el grupo corporativo.

## Configuración externa requerida

1. Crear un proyecto de Apps Script en la cuenta corporativa autorizada.
2. Copiar `google-apps-script/colaciones-forms.gs` y usar el manifiesto `google-apps-script/appsscript.json`.
3. Crear la propiedad `WORKERA_SHARED_SECRET` en Script Properties.
4. Desplegar como Web App ejecutada por el propietario y accesible por cualquiera; el secreto es la autorización de aplicación.
5. Guardar la URL terminada en `/exec` y el mismo secreto en `.env.local` como `GOOGLE_FORMS_WEB_APP_URL` y `GOOGLE_FORMS_SHARED_SECRET`.
6. Reiniciar el servidor de desarrollo para cargar la configuración.
