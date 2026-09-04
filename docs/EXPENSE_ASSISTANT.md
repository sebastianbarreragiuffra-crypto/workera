# Asistente de Rendiciones

## Propósito

El asistente entrega respuestas operacionales de solo lectura sobre Rendiciones. Está diseñado para que una persona de RR. HH., Finanzas o una jefatura pueda identificar trabajo pendiente sin construir filtros manuales y sin entregar información financiera a un proveedor de inteligencia artificial.

La primera versión responde tres preguntas predefinidas:

1. Qué rendiciones requieren atención.
2. Cuánto se aprobó o pagó durante una ventana de 7, 30 o 90 días.
3. Qué falta pagar o enviar a contabilidad.

## Límites de seguridad

- No existe entrada de texto libre ni se persisten conversaciones o prompts.
- La respuesta es calculada en PostgreSQL con reglas deterministas y versionadas.
- La empresa y la identidad se obtienen de la sesión; el navegador no elige `company_id` ni `actor_id`.
- La autorización se verifica en la aplicación y nuevamente dentro de la función SQL.
- Las preguntas de alertas y gasto requieren `expenses.read`, `expenses.approve` o `expenses.manage`. La pregunta de pagos/contabilidad exige `expenses.reconcile` o `expenses.manage`, porque resume superficies financieras más restringidas.
- El resultado contiene métricas agregadas y hasta 12 referencias de rendiciones. No incluye nombres, correos, datos bancarios, archivos ni referencias de transferencias.
- El asistente nunca aprueba, rechaza, paga, concilia, contabiliza ni edita datos de negocio.
- Cada usuario puede ver únicamente su propio historial y solo las intenciones que su permiso vigente autoriza. Las respuestas expiran a los 90 días mediante una purga global diaria autenticada como job interno.
- Existe un límite de 30 consultas por usuario y empresa por hora.

## Trazabilidad

Cada ejecución guarda la intención allowlisted, la ventana, un resultado estructurado, su hash SHA-256, el número de citas y la fecha. Las citas abren la rendición original para que la persona compruebe la evidencia antes de actuar.

No se guarda una copia de comprobantes ni de documentos. Si una regla cambia, las respuestas históricas conservan su versión de esquema y hash, mientras que una consulta nueva refleja el estado vigente.

## Frontera futura de IA

Un modelo externo solo podría incorporarse detrás de un proveedor explícito y desactivado por defecto. Antes de habilitarlo se requiere evaluación contractual, residencia y retención de datos, pruebas de fuga y prompt injection, redacción de PII, telemetría, presupuesto y consentimiento del cliente.

Incluso con un modelo, la recuperación de datos debe seguir siendo determinista y tenant-aware. El modelo recibiría un resumen minimizado, redactaría una explicación con citas y jamás tendría herramientas de escritura. Cualquier acción futura se presentaría como borrador y exigiría confirmación humana en el flujo normal de permisos.

## Operación

La migración `20260904210000_expense_readonly_assistant.sql` crea el contrato SQL, la bitácora, las políticas RLS y la purga global. El servicio `src/lib/expenses/assistant.ts` valida de forma estricta todos los resultados antes de mostrarlos. `/api/jobs/expense-assistant-retention` ejecuta la retención diariamente y exige el mismo `CRON_SECRET` fuerte de los demás jobs. Un cambio de contrato exige actualizar migración, tipos, esquema Zod, pruebas pgTAP y pruebas de aplicación en el mismo bloque.
