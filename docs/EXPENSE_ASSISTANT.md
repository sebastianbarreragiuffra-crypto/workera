# Asistente de Rendiciones

## Propósito

El asistente entrega respuestas operacionales reproducibles y de solo lectura de
negocio sobre Rendiciones. Está diseñado para identificar trabajo pendiente sin
construir filtros manuales y sin entregar información financiera a un proveedor
de inteligencia artificial. La propia bitácora sí se inserta y purga; “solo
lectura” no significa que la transacción completa sea `READ ONLY`.

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
- El RPC se invoca con la sesión, no con `service_role`, y una prueba inspecciona
  que su definición no contenga INSERT/UPDATE/DELETE sobre tablas financieras.
  Aun así, la función es `SECURITY DEFINER`; antes de conectar un LLM se exige una
  capacidad Postgres de lectura con grants explícitos y bitácora separada.
- Cada usuario puede ver únicamente su propio historial y solo las intenciones que su permiso vigente autoriza. Las respuestas expiran a los 90 días mediante una purga global diaria autenticada como job interno.
- Existe un límite de 30 consultas por usuario y empresa por hora.

## Trazabilidad

Cada ejecución guarda la intención allowlisted, la ventana, un resultado
estructurado, su hash SHA-256, el número de referencias y la fecha. Las referencias
abren rendiciones de ejemplo para comprobar contexto antes de actuar.

No se guarda una copia de comprobantes ni de documentos. El hash sirve para
detectar cambios del registro, pero no es firma, procedencia ni evidencia
tamper-evident; y el máximo de 12 referencias no es un manifiesto exhaustivo. Si
una regla cambia, las respuestas conservan versión de esquema y hash. Una versión
audit-grade futura debe añadir `asOf`, versión de cálculo, zona horaria, moneda/
redondeo y evidencia paginada.

La retención de 90 días es un valor técnico provisional. Antes de usar PII en un
ambiente compartido debe aprobarse su finalidad, allowlist de campos, acceso,
derechos, supresión/legal hold y plazo por asesoría legal/privacidad.

## Frontera futura de IA

Un modelo externo solo podría incorporarse detrás de un proveedor explícito y desactivado por defecto. Antes de habilitarlo se requiere evaluación contractual, residencia y retención de datos, pruebas de fuga y prompt injection, redacción de PII, telemetría, presupuesto y consentimiento del cliente.

Incluso con un modelo, la recuperación de datos debe seguir siendo determinista y
tenant-aware. El modelo recibiría un resumen minimizado, redactaría una explicación
con referencias y jamás tendría herramientas de escritura. Cualquier borrador se
convierte en una intención tipada: el backend descarta montos/personas/estados del
modelo, relee, recalcula y reautoriza antes de ofrecer confirmación humana.

Quedan prohibidos ranking de desempeño, disciplina, despido, modificación salarial,
denegación automática, cambio de asistencia, aprobación, conciliación, pago o
contabilización. OCR/matching/alertas deben permitir abstención, corrección,
override motivado y apelación; un clic humano no basta sin revisión significativa.

## Operación

La migración `20260904210000_expense_readonly_assistant.sql` crea el contrato SQL, la bitácora, las políticas RLS y la purga global. El servicio `src/lib/expenses/assistant.ts` valida de forma estricta todos los resultados antes de mostrarlos. `/api/jobs/expense-assistant-retention` ejecuta la retención diariamente y exige el mismo `CRON_SECRET` fuerte de los demás jobs. Un cambio de contrato exige actualizar migración, tipos, esquema Zod, pruebas pgTAP y pruebas de aplicación en el mismo bloque.
