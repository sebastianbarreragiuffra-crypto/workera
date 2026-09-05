# Documentos laborales privados — protocolo de carga

Estado: `TESTED_LOCAL`. Aplica a licencias médicas y documentos de respaldo del
dominio laboral. No activa proveedores ni cambia datos hospedados.

## Flujo vigente

1. La Server Action autentica y autoriza al trabajador antes de leer el archivo
   completo, y rechaza más de 10 MiB.
2. `validateSupportingDocumentFile` reconoce PDF, JPEG o PNG por sus bytes
   iniciales; el MIME enviado por el navegador no es autoridad.
3. `reserve_supporting_document_upload` vuelve a autorizar en PostgreSQL,
   aplica AAL2 cuando corresponda y crea una ruta opaca por 10 minutos.
4. La policy de Storage solo acepta esa ruta, para ese actor. El bucket es
   privado y también impone 10 MiB y la allowlist de MIME.
5. `register_supporting_document_upload` comprueba que el objeto existe,
   valida que el caso relacionado pertenece al mismo trabajador y escribe
   metadata + auditoría en una transacción.
6. Para licencias, `create_pending_medical_license` crea la ausencia, el
   documento y la aprobación `PENDING_RRHH_APPROVAL` en un único commit. Nunca
   acepta actor ni estado desde el cliente y nunca autoaprueba.
7. Si Storage o el commit devuelve error, la aplicación intenta borrar el
   objeto mientras sigue huérfano. La policy impide borrar uno ya registrado.
8. Si la aplicación cae antes de compensar, un job diario reclama reservas
   vencidas con 5 minutos de gracia, `SKIP LOCKED` y fencing. PostgreSQL excluye
   cualquier ruta registrada antes de entregarla al worker; el borrado se
   reintenta como máximo tres veces y termina en auditoría sin guardar la ruta.
9. Cada ejecución devuelve un snapshot agregado sin PII. Un fallo terminal o
   un backlog mayor al umbral responde HTTP 503 para que el monitor del cron
   pueda alertar; el umbral conservador es 26 horas.

## Entrega vigente

1. El Route Handler acepta solo UUID y un perfil privilegiado activo.
2. `authorize_supporting_document_download` vuelve a resolver el documento y
   su empresa, exige membresía vigente y AAL2, consume una cuota PostgreSQL y
   registra la autorización antes de devolver la ruta privada.
3. La policy de `storage.objects` repite empresa + rol + MFA y solo permite una
   ruta que ya tenga metadata registrada. Revocar la membresía corta acceso a
   tabla, vista, RPC y Storage.
4. Next.js descarga el objeto con el JWT de sesión y entrega los bytes como
   `attachment`, `application/octet-stream`, `nosniff`, `no-store`, sandbox y
   sin referrer. Ya no redirige ni expone una signed URL al navegador.

La cuota inicial de entrega es 60 documentos por actor/empresa cada 5 minutos.
La primera solicitud bloqueada queda auditada y el contador se satura para no
convertir el ledger en un vector de amplificación.

La cuota inicial es 30 objetos y 100 MiB acumulados por actor/hora. Es un valor
conservador para marcha blanca y debe calibrarse con métricas sintéticas antes
de declararlo definitivo. El contador vive en Postgres y funciona con varias
instancias de Next.js.

## Evidencia

- Migración: `20260905120000_supporting_document_upload_guard.sql`.
- pgTAP: `074_supporting_document_upload_guard.sql` (48 invariantes).
- Descarga/aislamiento: `20260905130000_supporting_document_download_guard.sql`
  y `075_supporting_document_download_guard.sql` (53 invariantes).
- Tests TypeScript: `src/lib/decisions/documents.test.ts` y
  `src/lib/decisions/medical-license.test.ts`, más el worker y Route Handler en
  `src/lib/supporting-document-cleanup/` y
  `src/app/api/jobs/supporting-document-cleanup/`.
- Recolección de huérfanos: migración
  `20260905170000_supporting_document_orphan_sweeper.sql`, salud agregada en
  `20260905180000_supporting_document_cleanup_health.sql` y pgTAP 079–080.
- Inventario: `src/lib/architecture/server-action-surfaces.ts`.

## Límites que siguen abiertos

- PDF/JPG/PNG continúa siendo contenido no confiable. Magic bytes no sustituyen
  antimalware/CDR; no servir documentos inline y conectar escaneo antes de una
  marcha blanca con archivos reales fuera de un grupo controlado.
- El sweeper ya conserva contadores por ejecución y auditoría terminal, pero
  falta exportar esas señales a observabilidad hospedada y alertar cuando haya
  `FAILED`; el endpoint permanece apagado por defecto hasta verificar staging.
- La autorización auditada ocurre antes de buscar los bytes: demuestra una
  entrega autorizada, no que la transferencia HTTP haya terminado. Métricas
  hospedadas deben distinguir autorización, fallo de Storage y respuesta 200.

No revertir a INSERT directo sobre `supporting_documents` o
`medical_license_approvals`, ni volver a incluir el filename original en la ruta
de Storage. Tampoco volver a una redirección firmada ni servir estos archivos
inline mientras no exista cuarentena/antimalware laboral. Esas decisiones son
intencionales.
