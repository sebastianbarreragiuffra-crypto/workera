# Runbook de preparación para staging y marcha blanca

Estado vigente: **GO únicamente para desarrollo local aislado con datos
sintéticos**. El staging compartido, la marcha blanca con PII, los conectores
reales y producción siguen en **NO-GO** hasta que el reporte ejecutable indique
lo contrario y los responsables acepten los riesgos que no son técnicos.

Este documento no autoriza un despliegue. Organiza el camino verificable para
que un cambio de estado no dependa de memoria, una conversación o una falsa
sensación de avance.

## 1. Obtener la decisión actual

```bash
npm run readiness:report
```

El reporte evalúa cinco alcances distintos:

| Alcance | Uso permitido hoy | Regla principal |
|---|---|---|
| `LOCAL_SYNTHETIC` | **GO** | datos ficticios, integraciones apagadas |
| `SANITIZED_STAGING` | **NO-GO** | primero sanear y verificar controles hospedados |
| `ARCOTEX_LABOR_PILOT` | **NO-GO** | puede exceptuar aislamiento de un segundo tenant solo si ARCOTEX sigue siendo el único workspace laboral |
| `EXPENSES_PILOT` | **NO-GO** | Rendiciones es multiempresa, pero aún requiere seguridad/operación real |
| `MULTI_COMPANY_PRODUCTION` | **NO-GO** | ninguna excepción de aislamiento laboral |

Para convertir la decisión local en un check de CI:

```bash
npm run readiness:local
```

Para impedir una promoción accidental se puede ejecutar, por ejemplo,
`npm run readiness:report -- --enforce=EXPENSES_PILOT`. Mientras existan gates
abiertos terminará con código distinto de cero. No se cambia ese resultado
silenciando el comando: se agrega evidencia y se actualiza el gate revisado.

La fuente de verdad está en
`src/lib/architecture/pilot-readiness.ts`. Cada deuda descubierta en los
inventarios HTTP, Server Actions, RPC o Storage entra automáticamente en el
piloto de su dominio.

## 2. Decisiones que no deben revertirse

1. Conservar el producto existente; no reconstruir la aplicación desde cero.
2. GESTORA es multiempresa. El control plane y los workspaces de cliente son
   contextos distintos; un rol de plataforma no concede acceso implícito a PII.
3. ARCOTEX es el único workspace laboral habilitable hasta completar MT-3B-D.
   Esta excepción permite preparar una marcha blanca acotada, no copiar su
   modelo legacy a clientes nuevos.
4. Rendiciones se habilita por empresa como módulo/entitlement. No crear forks
   de código ni despliegues especiales por cliente.
5. MFA, Workera, correo, WhatsApp, OCR y exportación contable permanecen detrás
   de flags. Nunca activar varios proveedores a la vez para “probar rápido”.
6. OCR, asistentes y matching entregan sugerencias. Ningún agente o modelo
   aprueba gastos, modifica asistencia, rechaza licencias ni inicia pagos.
7. Ningún éxito local se etiqueta como `DEPLOYED_STAGING` o `PRODUCTION`.

## 3. Secuencia de promoción

### Paso A — congelar un candidato reproducible

- Trabajar desde un commit pusheado y con estado Git limpio; preservar los
  cambios existentes de otros agentes.
- Registrar rama, SHA y migración más reciente.
- Confirmar que el build candidato contiene exactamente las mismas migraciones
  que se ensayarán; no generar una migración durante la ventana de promoción.
- Revisar `AGENTS.md`, la sección Pinned del `README.md` y el motivo del último
  commit que tocó cualquier archivo en conflicto.

### Paso B — repetir evidencia local

Ejecutar sobre una pila Supabase **aislada del worktree compartido** siguiendo
`docs/LOCAL_SETUP.md`:

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
npx supabase test db
npx supabase db lint --level warning
npm run readiness:local
```

Un fallo invalida el candidato; no se cambia el test para acomodar el resultado
sin entender primero qué frontera protegía.

### Paso C — sanear staging antes de cualquier dato nuevo

- Mantener el SECURITY HOLD de `docs/STAGING_ENVIRONMENT.md`.
- Inventariar los 97 registros existentes sin copiar PII a logs, issues o chat.
- Obtener autorización para eliminar/anonimizar o aplicar controles equivalentes
  a producción. Conservar evidencia del criterio y del resultado, no el dataset.
- Usar cuentas personales de prueba y roles mínimos; nunca compartir una cuenta
  administrativa.
- Verificar que todos los conectores sigan apagados después del saneamiento.

Condición de salida: el owner de Privacy/Platform confirma que staging contiene
solo datos sintéticos/minimizados permitidos y el gate
`SYNTHETIC_STAGING_DATA` cambia con evidencia revisable.

### Paso D — aplicar migraciones con rollback preparado

- Ejecutar primero un dry-run del proyecto enlazado y comparar su head con Git.
- Guardar respaldo previo fuera del repositorio. Una copia de Postgres no cubre
  por sí sola los objetos de Storage.
- Respetar el despliegue MFA en dos cortes descrito en
  `docs/PLATFORM_OWNER_RUNBOOK.md`; no aplicar en un solo lote la guarda AAL2 si
  el OWNER aún no posee dos factores recuperables.
- Aplicar únicamente migraciones revisadas del SHA candidato.
- Ante una diferencia inesperada, detener la promoción; no resetear staging ni
  editar el historial de migraciones para forzar coincidencia.

### Paso E — verificar Auth y MFA con el owner presente

- Confirmar límites reales de Auth, recuperación y no enumeración de cuentas.
- Inscribir dos TOTP del OWNER en dispositivos distintos y comprobar AAL2.
- Probar login, expiración, revocación, factor perdido y procedimiento
  break-glass con una cuenta de prueba antes de depender de él.
- Activar enforcement según el runbook, comprobar todos los roles y conservar
  el rollback listo durante la ventana.

Condición de salida: no existe una ruta privilegiada AAL1 y una pérdida de un
factor no deja a la organización sin OWNER recuperable.

### Paso F — observabilidad y recuperación

- Enviar eventos de Auth, control plane, descargas/exportaciones, jobs,
  `service_role` y backups a un sink separado y con retención definida.
- Crear SLI de disponibilidad, errores, frescura Workera, profundidad de cola,
  leases vencidos, DLQ, límites excedidos y ausencia de backups.
- Configurar alertas accionables con responsable, severidad y tiempo de atención.
- Disparar cada alerta con un canario; verla en un dashboard no demuestra paging.
- Restaurar DB y Storage en un ambiente aislado, validar manifiesto/checksums,
  reconfigurar servicios y medir RPO/RTO y rollback.

### Paso G — habilitar un solo alcance de piloto

Elegir explícitamente **uno**:

#### Marcha blanca laboral ARCOTEX

- Mantener todos los demás workspaces laborales bloqueados.
- Cerrar límites de las decisiones laborales y la carga/descarga segura de
  documentos incluida en el alcance.
- Probar Workera con un canario pequeño, reconciliar conteos y verificar que una
  corrida parcial/fallida nunca se muestre “al día”.
- Revisar manualmente asistencia, novedades, reglas y exportaciones antes de
  que afecten nómina.

#### Piloto de Rendiciones

- Habilitar `expenses` solo para la empresa piloto y un grupo pequeño.
- Mantener correo, WhatsApp, OCR y contabilidad apagados inicialmente.
- Probar el flujo manual completo: borrador, comprobante, envío, doble
  aprobación cuando aplica, conciliación y exportación auditada.
- Conectar después un canal por vez, solo tras cerrar antimalware, rate limit de
  borde, canario, replay, DLQ y rollback de ese canal.

En ambos casos se requiere DAST/pentest del build exacto, prueba de carga, soak,
runbook de incidentes y aceptación formal de Security, Privacy y negocio.

## 4. Flags seguros durante la preparación

El valor esperado antes de un canario autorizado es:

```text
WORKERA_PROVIDER=mock
WORKERA_SYNC_ENABLED=false
EXPENSE_FILE_SCAN_PROVIDER=disabled
EXPENSE_FILE_SCAN_ENABLED=false
EXPENSE_FILE_SCAN_ALLOW_FIXTURE=false
SUPPORTING_DOCUMENT_CLEANUP_ENABLED=false
SUPPORTING_DOCUMENT_CLEANUP_MONITOR_EXPECT_ENABLED=false
EXPENSE_OCR_PROVIDER=disabled
EXPENSE_OCR_ENABLED=false
EXPENSE_EMAIL_CAPTURE_ENABLED=false
EXPENSE_WHATSAPP_CAPTURE_ENABLED=false
EXPENSE_ACCOUNTING_PROVIDER=disabled
EXPENSE_ACCOUNTING_EXPORT_ENABLED=false
MFA_ENFORCEMENT_ENABLED=false
```

`MFA_ENFORCEMENT_ENABLED=false` no relaja las guardas AAL2 ya incorporadas a
operaciones sensibles. Solo evita forzar el rollout global antes de que el owner
complete inscripción y recuperación. Su activación sigue el runbook específico.

## 5. Criterios de rollback

Detener o revertir la habilitación —sin borrar evidencia— si ocurre cualquiera:

- acceso entre empresas, rol inesperado o operación privilegiada en AAL1;
- documento descargable antes de veredicto permitido o servido inline;
- migración parcial, drift no explicado o pérdida de RLS/grants;
- falta de backup reciente, restore fallido o checksum inconsistente;
- provider timeout con resultado externo incierto y sin reconciliación;
- cola/DLQ fuera de umbral, sync sin frescura o alerta que no llega al on-call;
- PII en logs, errores, trazas, tickets o artefactos de prueba;
- una aprobación/pago/decisión laboral automática o sin segregación requerida.

Rollback significa apagar el flag o entitlement del alcance afectado, detener
workers/schedulers, preservar logs e idempotency keys, reconciliar efectos ya
emitidos y seguir el runbook de incidente. No usar `git reset --hard`, no borrar
filas de auditoría y no ejecutar `supabase db reset` sobre staging.

## 6. Evidencia mínima para declarar GO

El acta debe incluir, sin credenciales ni datos personales:

- ambiente, alcance, rama, commit y head de migraciones;
- resultado de tests/build/pgTAP/lint DB del mismo candidato;
- roles y casos negativos verificados;
- evidencia de AAL2 y recuperación (sin secreto TOTP ni QR);
- resultado del restore drill y RPO/RTO;
- canarios, carga/soak, DAST/pentest y hallazgos cerrados/aceptados;
- dashboards/alertas y prueba de paging;
- flags y empresas/módulos habilitados;
- riesgos residuales con owner, compensación, expiración y firma de decisión;
- rollback ejecutable y responsables de guardia.

Si falta uno de estos puntos, el alcance continúa en `NO-GO`, aunque la interfaz
se vea completa o todas las pruebas locales pasen.
