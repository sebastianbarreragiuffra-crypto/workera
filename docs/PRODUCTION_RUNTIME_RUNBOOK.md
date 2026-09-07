# Operación continua y despliegue — GESTORA/Workera

Estado auditado: 7 de septiembre de 2026. Este runbook prepara el sistema para
funcionar sin un computador encendido. No autoriza por sí solo una marcha blanca
ni la activación de integraciones reales.

## Decisión de arquitectura

- **Aplicación web/PWA y backend Next.js:** Vercel.
- **Base, Auth, MFA y Storage privado:** Supabase hospedado.
- **Procesos programados:** Vercel Cron invoca Route Handlers protegidos con un
  `CRON_SECRET` independiente.
- **Fuente del código y despliegues:** GitHub; staging y producción son proyectos
  separados y usan secretos separados.
- **Procesamiento:** conservar el monolito modular. Un worker dedicado se evalúa
  solo cuando la duración, frecuencia o carga excedan los límites medidos de las
  Functions.

El navegador y los computadores de Sebastián no participan en este recorrido.
Pueden estar apagados: Vercel atiende las solicitudes y dispara los cron;
Supabase conserva los datos y las sesiones.

## Evidencia encontrada

Auditoría de solo lectura sobre el proyecto enlazado
`arcotex-workera-staging`:

- el dominio canónico `https://arcotex-workera-staging.vercel.app/login`
  respondió `200`;
- los despliegues más recientes figuran `Ready`;
- los endpoints de Workera y OCR respondieron `401` sin secreto, que es el
  comportamiento seguro;
- `vercel.json` declara siete procesos diarios;
- Vercel no tiene `CRON_SECRET`, por lo que hoy ninguno de esos procesos puede
  atravesar el middleware;
- Vercel tampoco lista `WORKERA_BASE_URL`, `WORKERA_API_USER` ni
  `WORKERA_API_KEY`; no se puede declarar operativo el sync real;
- `MFA_ENFORCEMENT_ENABLED` sí está activo en Vercel;
- no existe todavía un ambiente local ni un proyecto enlazado llamado
  producción; el único proyecto inspeccionado es staging.

El archivo local `.env.staging` no coincide con Vercel: local declara secreto de
cron y Workera completo, pero no refleja el origen/MFA hospedados. Los archivos
locales sirven para ejecutar herramientas; **Vercel es la fuente efectiva del
runtime hospedado**. Nunca se copian valores secretos a Git ni a este documento.

## Hallazgos corregidos en código

Dos rutas incluidas en `vercel.json` no atravesaban el middleware aunque su
handler revalidaba correctamente el secreto:

- `/api/jobs/expense-file-scan`;
- `/api/jobs/supporting-document-cleanup`.

Se incorporaron al allowlist exacto de cron. El método debe ser `GET`, la ruta
debe coincidir completamente y el Bearer debe superar la validación común. Una
prueba compara todo `vercel.json` con ese allowlist para que un cron nuevo sin
frontera de autenticación rompa CI.

También existe `/api/health/live`, una señal pública mínima y no cacheada. Solo
confirma DNS/CDN/runtime; no consulta la base, no expone versión, empresa,
usuarios, proveedores ni estado interno. Un `200 {"status":"ok"}` no prueba que
Workera o la base estén sanos.

## Preflight reproducible

`npm run readiness:hosting` valida el ambiente cargado en el proceso:

- origen HTTPS canónico;
- cliente público y credencial server-only de Supabase;
- MFA activo;
- manifiesto exacto de los siete cron;
- `CRON_SECRET` de al menos 32 caracteres;
- dependencias completas de cada integración que se intente habilitar;
- proveedores no aprobados permanecen `SAFE_DISABLED`.

Ejemplo para un archivo local que representa staging:

```powershell
node --env-file=.env.staging --import=tsx scripts/hosting-runtime-readiness.mts
```

Un valor oculto como `[SENSITIVE]` no cuenta como evidencia: el preflight debe
ejecutarse dentro del ambiente que recibe los valores reales o contra un archivo
local protegido que los contenga.

## Secuencia segura para staging

1. Desplegar este bloque manteniendo todas las integraciones mutativas apagadas.
2. Confirmar que `/api/health/live` responde `200` desde un monitor externo.
3. Generar un `CRON_SECRET` nuevo de alta entropía y guardarlo únicamente en el
   gestor de variables de Vercel.
4. Mantener inicialmente en `false` Workera, OCR, escáner, salida contable y
   limpieza documental; una invocación autorizada debe terminar inerte.
5. Configurar un monitor externo que alerte por caída de liveness y por ausencia
   de ejecuciones. Vercel no reintenta automáticamente un cron fallido.
6. Verificar/contratar backups adecuados de Supabase y ejecutar un restore
   aislado de DB y Storage antes de usarlo como garantía.
7. Sanear staging y recién entonces ejecutar un canario Workera read-only.
8. Activar `WORKERA_SYNC_ENABLED=true` en una ventana controlada, revisar el
   `sync_run`, el motor de reglas y los totales con RR. HH.; revertir a `false`
   ante cualquier discrepancia.

No activar el escáner de archivos: el repositorio solo implementa un fixture
local y falla cerrado en producción. OCR y salida contable siguen sus propios
runbooks y no forman parte de la marcha blanca laboral inicial.

## Producción

Producción se crea solo después del GO de ARCOTEX y debe tener:

- proyecto Vercel separado, dominio definitivo y despliegue desde una rama
  protegida;
- proyecto Supabase separado; nunca reutilizar staging;
- secretos nuevos, no copiados literalmente desde staging;
- plan de backup/retención aprobado y restore demostrado;
- SMTP propio, límites Auth/CAPTCHA, monitoreo, responsables y respuesta a
  incidentes;
- despliegue de migraciones automatizado y reversible;
- canarios y feature flags apagados por defecto.

## Rollback

- caída web: promover el último deployment sano;
- error de Workera: `WORKERA_SYNC_ENABLED=false` y redesplegar, sin borrar los
  eventos ya versionados;
- error de un proveedor de Rendiciones: apagar solo su flag; nunca revertir una
  decisión humana ni marcar como exitoso un timeout incierto;
- posible exposición de `CRON_SECRET`: rotarlo en Vercel y redesplegar;
- incidente de datos: detener integraciones, preservar evidencia y seguir el
  plan de backup/recuperación. Nunca ejecutar un reset contra staging o
  producción.

## Gate de cierre

La infraestructura se considera operativa solamente cuando existan, en el mismo
deployment candidato:

- preflight `READY`;
- liveness monitoreado con alerta probada;
- cron autenticado y ejecución observada;
- canario Workera reconciliado con RR. HH.;
- backup y restauración demostrados;
- responsable y procedimiento de incidente asignados.

Hasta entonces el sistema puede estar **online**, pero no debe describirse como
operación continua garantizada.
