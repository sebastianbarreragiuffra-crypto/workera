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

La cuota inicial es 30 objetos y 100 MiB acumulados por actor/hora. Es un valor
conservador para marcha blanca y debe calibrarse con métricas sintéticas antes
de declararlo definitivo. El contador vive en Postgres y funciona con varias
instancias de Next.js.

## Evidencia

- Migración: `20260905120000_supporting_document_upload_guard.sql`.
- pgTAP: `074_supporting_document_upload_guard.sql` (48 invariantes).
- Tests TypeScript: `src/lib/decisions/documents.test.ts` y
  `src/lib/decisions/medical-license.test.ts`.
- Inventario: `src/lib/architecture/server-action-surfaces.ts`.

## Límites que siguen abiertos

- PDF/JPG/PNG continúa siendo contenido no confiable. Magic bytes no sustituyen
  antimalware/CDR; no servir documentos inline y conectar escaneo antes de una
  marcha blanca con archivos reales fuera de un grupo controlado.
- Una caída definitiva entre upload y compensación puede dejar un objeto con
  reserva vencida. Falta un sweeper server-side que liste reservas vencidas,
  elimine sus objetos mediante Storage API y produzca métrica/alerta.
- La descarga conserva signed URL de 60 segundos, pero aún necesita rate limit
  y auditoría de cada entrega, igual que ya se implementó en Rendiciones.

No revertir a INSERT directo sobre `supporting_documents` o
`medical_license_approvals`, ni volver a incluir el filename original en la ruta
de Storage. Ambos privilegios directos fueron revocados intencionalmente.
