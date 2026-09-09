# Paquete mínimo de gates humanos — ARCOTEX_LABOR_PILOT

Estado del paquete: **PREPARADO, NO APROBADO**. Estado operativo inicial:
`BLOQUEADO`.

Este documento organiza la evidencia humana de `INCIDENT_RESPONSE`,
`PRIVACY_AND_LEGAL` y `RESIDUAL_RISK_ACCEPTANCE`. No los cierra, no reemplaza
una firma ni autoriza staging, datos reales, marcha blanca, despliegues,
migraciones, integraciones o decisiones laborales. Durante toda la preparación:
`WORKERA_SYNC_ENABLED=false`.

## Reglas de evidencia

- Completar únicamente roles, fechas, decisiones, estados y referencias opacas
  a repositorios protegidos con acceso mínimo.
- No copiar aquí credenciales, PII, nombres, RUT, correos, IDs, capturas,
  trazas, filas, HTML, XLSX, secretos ni enlaces públicos.
- Una referencia protegida identifica el artefacto y su custodio sin revelar su
  contenido. El revisor autorizado consulta el original en el sistema privado.
- `PENDIENTE` significa que falta una acción o evidencia humana. `BLOQUEADO`
  significa que el piloto no puede abrirse. Solo la autoridad indicada puede
  registrar `ACEPTADO`, con fecha y expiración cuando corresponda.
- La ausencia, ambigüedad o caducidad de una firma o evidencia equivale a
  `BLOQUEADO`; nunca se infiere aprobación por silencio.

## Control de la ventana

- Alcance inmutable: `ARCOTEX_LABOR_PILOT`.
- Empresa: ARCOTEX.
- Población máxima: 45 trabajadores previamente autorizados, registrada solo
  como conteo agregado.
- Módulo: Asistencia solamente.
- Estado de apertura: `BLOQUEADO`.
- Ventana propuesta (inicio/fin y zona horaria): `PENDIENTE`.
- Hora límite para decisión de apertura: `PENDIENTE`.
- Guardia primaria y suplente, identificadas por rol: `PENDIENTE`.
- Canal privado de incidente y canal alternativo: `PENDIENTE`.
- Dueño de la pausa operativa: Plataforma de guardia.
- Autoridad de reanudación: dueño del gate afectado y Dueño de decisión de
  Negocio; requiere gate hospedado y SHA nuevamente válidos.
- Flags/proveedores: `WORKERA_SYNC_ENABLED=false`; los demás módulos e
  integraciones fuera de alcance permanecen apagados.

La ventana queda `BLOQUEADA` mientras cualquiera de los tres gates de este
paquete no esté aceptado o mientras falte un prerequisito de
`docs/ARCOTEX_SHADOW_OPERATION_CHECKLIST.md`.

## Responsables y segregación

| Función | Responsable por rol | Evidencia/decisión requerida | Estado inicial |
|---|---|---|---|
| Decisión de apertura/cierre | Dueño de decisión de Negocio ARCOTEX | firma y fecha | `PENDIENTE` |
| Respuesta a incidentes | Security/Incident Commander | plan, RACI, tabletop y paging | `BLOQUEADO` |
| Privacidad y finalidad | Privacy/Legal/Product | RoPA/DPIA, finalidad, contratos, avisos, retención y derechos | `BLOQUEADO` |
| Riesgo residual técnico | Security | registro y recomendación firmada | `PENDIENTE` |
| Aceptación de riesgo residual | Negocio, Product, Data Owner y Plataforma, según corresponda | aceptación o rechazo con expiración | `PENDIENTE` |
| Operación y pausa | Plataforma de guardia | cobertura de ventana y capacidad de detener | `PENDIENTE` |
| Custodia de evidencia | Secretario de acta | referencias protegidas y acceso mínimo | `PENDIENTE` |

La misma persona no puede emitir por sí sola la recomendación de Security y la
aceptación de Negocio/Data Owner. Privacy/Legal conserva autoridad propia sobre
sus obligaciones; Negocio no puede exceptuarlas mediante aceptación de riesgo.

## Trazabilidad con el reporte ejecutable

Este paquete conserva, sin reinterpretarlos, los owners y próximas acciones de
`src/lib/architecture/pilot-readiness.ts`:

| Gate | Estado de readiness que debe conservar | Owners mínimos | Salida humana requerida |
|---|---|---|---|
| `INCIDENT_RESPONSE` | `REQUIRES_OWNER_DECISION` | Security / Legal / Leadership | on-call, severidades, contactos, preservación de evidencia y tabletop |
| `PRIVACY_AND_LEGAL` | `REQUIRES_OWNER_DECISION` | Privacy / Legal / Product | RoPA/DPIA, derechos, transferencias, retención, contratos y avisos |
| `RESIDUAL_RISK_ACCEPTANCE` | `REQUIRES_OWNER_DECISION` | Business / Security / Data Owners | owner, compensación, vencimiento y autoridad GO/NO-GO por riesgo |

Completar este documento no cambia por sí solo el reporte ejecutable. El gate
solo puede actualizarse mediante una revisión separada que compruebe las
decisiones originales en sus repositorios protegidos.

## Gate `INCIDENT_RESPONSE`

Estado inicial: **`BLOQUEADO`**.

Para cambiarlo a `ACEPTADO`, Security/Incident Commander debe confirmar:

- [ ] Severidades, criterios de declaración y autoridad para ordenar pausa.
- [ ] RACI y guardia primaria/suplente durante toda la ventana.
- [ ] Canal privado y alternativa fuera de banda comprobados.
- [ ] Procedimiento de contención que detenga revisión y descargas sin borrar
      auditoría ni evidencia.
- [ ] Preservación forense, control de acceso, cadena de custodia y retención.
- [ ] Rotación/revocación y contactos de proveedores definidos, sin secretos en
      el acta.
- [ ] Matriz de comunicaciones y evaluación de notificación legal aprobadas por
      Privacy/Legal.
- [ ] Tabletop ejecutado y prueba de paging recibida por la guardia de la
      ventana; los hallazgos bloqueantes están cerrados.
- [ ] Tiempo objetivo de reconocimiento y escalamiento acordado.

Registro de decisión sanitizado:

- `evidence_id`: `INCIDENT_RESPONSE_APPROVAL`.
- `evidence_type`: `HUMAN_GATE_APPROVAL`.
- `owner_role`: `PENDING`.
- `generated_at`: `PENDING`.
- `expires_at`: `PENDING`.
- `protected_reference`: `NONE`.
- `sha256_digest`: `NONE`.
- `verifier_role`: `PENDING`.
- `verified_at`: `NONE`.
- `status`: `PENDING | VERIFIED | FAILED | EXPIRED` (inicial: `PENDING`).
- `notes`: observación sanitizada o `NONE`.
- Referencia protegida al tabletop/paging: `PENDIENTE`.
- Hallazgos abiertos por severidad, solo agregados: `PENDIENTE`.

Solo `VERIFIED`, con vigencia activa, referencia protegida y digest coincidente
con el original consultado por el verificador, permite considerar satisfecho
este gate dentro del paquete de evidencia. No equivale a `GO`.

## Gate `PRIVACY_AND_LEGAL`

Estado inicial: **`BLOQUEADO`**.

Para cambiarlo a `ACEPTADO`, Privacy/Legal debe confirmar por escrito:

- [ ] Finalidad y alcance de la revisión en sombra, sin efectos de nómina,
      disciplina ni decisión laboral automatizada.
- [ ] RoPA actualizado y avisos de privacidad aplicables revisados.
- [ ] Categorías mínimas de datos permitidas y prohibición de reutilización.
- [ ] Base jurídica/contractual aplicable y roles de las partes documentados en
      el repositorio privado correspondiente.
- [ ] Acceso por cuentas personales, mínimo privilegio y segregación revisados.
- [ ] Retención, eliminación al vencimiento y legal hold definidos para acta,
      evidencia y copia XLSX protegida.
- [ ] Procedimiento para derechos, consultas, corrección y reclamos definido.
- [ ] Transferencias, proveedores y ubicaciones de tratamiento revisados cuando
      apliquen.
- [ ] Evaluación de impacto o justificación documentada de por qué no aplica.
- [ ] Protocolo de incidente/notificación alineado con `INCIDENT_RESPONSE`.

Registro de decisión sanitizado:

- `evidence_id`: `PRIVACY_AND_LEGAL_APPROVAL`.
- `evidence_type`: `HUMAN_GATE_APPROVAL`.
- `owner_role`: `PENDING`.
- `generated_at`: `PENDING`.
- `expires_at`: `PENDING`.
- `protected_reference`: `NONE`.
- `sha256_digest`: `NONE`.
- `verifier_role`: `PENDING`.
- `verified_at`: `NONE`.
- `status`: `PENDING | VERIFIED | FAILED | EXPIRED` (inicial: `PENDING`).
- `notes`: observación sanitizada o `NONE`.
- Restricciones obligatorias de la ventana: `PENDIENTE`.

La referencia protegida debe cubrir el dictamen, RoPA/DPIA y avisos aplicables,
sin copiar esos artefactos. Solo `VERIFIED` vigente y con digest conciliado
satisface el gate dentro del paquete; no equivale a `GO`.

## Gate `RESIDUAL_RISK_ACCEPTANCE`

Estado inicial: **`BLOQUEADO`**. No se aceptan riesgos por clase completa ni
mediante una frase genérica. Cada riesgo conserva un registro separado.

Campos mínimos por riesgo:

- ID opaco del riesgo y descripción sanitizada.
- Gate/control de origen y severidad residual.
- Impacto dentro de `ARCOTEX_LABOR_PILOT`.
- Control compensatorio verificable durante la ventana.
- Indicador/umbral que activa pausa.
- Owner del tratamiento y owner de monitoreo, por rol.
- Referencia protegida a la evidencia de eficacia.
- Decisión `RECHAZADO | ACEPTADO_TEMPORALMENTE`.
- Recomendación separada de Security y firmas de Negocio, Product, Data Owner y
  Plataforma según el riesgo y su owner efectivo.
- Fecha de decisión, expiración no posterior al fin de la ventana y condición de
  revocación.

Antes de firmar, Security debe reconciliar el registro con
`docs/THREAT_MODEL_CURRENT.md`. Todo riesgo marcado allí como “no aceptado” o
`BLOCKED` permanece bloqueante hasta que exista mitigación verificada o una
aceptación temporal explícita que Privacy/Legal permita aceptar. La aceptación
no convierte una deuda técnica en control implementado.

Resumen sanitizado del registro:

| Riesgo opaco | Severidad | Compensación | Owner por rol | Expira | Decisión | Referencia protegida |
|---|---|---|---|---|---|---|
| `PENDIENTE` | `PENDIENTE` | `PENDIENTE` | `PENDIENTE` | `PENDIENTE` | `BLOQUEADO` | `PENDIENTE` |

Registro de aprobación compatible con el manifiesto:

- `evidence_id`: `RESIDUAL_RISK_ACCEPTANCE`.
- `evidence_type`: `HUMAN_GATE_APPROVAL`.
- `owner_role`: `PENDING`.
- `generated_at`: `PENDING`.
- `expires_at`: `PENDING`.
- `protected_reference`: `NONE`.
- `sha256_digest`: `NONE`.
- `verifier_role`: `PENDING`.
- `verified_at`: `NONE`.
- `status`: `PENDING | VERIFIED | FAILED | EXPIRED` (inicial: `PENDING`).
- `notes`: observación sanitizada o `NONE`.

Este registro agregado solo puede quedar `VERIFIED` cuando cada riesgo del
registro protegido tiene las firmas, compensación y vigencia exigidas, y su
digest fue conciliado. No equivale a `GO`.

## Criterios de pausa inmediata

Cualquier participante puede ordenar `PAUSA`, sin votación, ante:

- gate, firma, referencia, guardia o evidencia ausente, vencida o no verificable;
- SHA/gate hospedado no coincidente, redespliegue o cambio de ventana/alcance;
- PII, secreto, captura, traza, fila, HTML o XLSX fuera del repositorio protegido;
- acceso inesperado, cuenta compartida, AAL1 o indicio de cruce entre empresas;
- integración, sincronización o módulo fuera de alcance activo, incluido
  `WORKERA_SYNC_ENABLED` distinto de `false`;
- alerta sin recepción/owner, degradación o cambio de conteos no explicado;
- incidente, sospecha de vulneración, pérdida de evidencia o falla de custodia;
- uso del resultado para nómina, disciplina o decisión laboral;
- control compensatorio ausente o umbral de riesgo alcanzado.

Al pausar: detener la revisión y nuevas descargas, preservar evidencia mínima,
registrar hora/rol/criterio y escalar por el canal privado. No borrar, reparar,
reprocesar, desplegar, migrar, cambiar flags ni acceder a staging desde este
paquete. La reanudación abre una nueva sesión en
`docs/ARCOTEX_SHADOW_OPERATION_RECORD_TEMPLATE.md`.

## Decisión conjunta de apertura

Completar solo después de aceptar individualmente los tres gates:

- `INCIDENT_RESPONSE`: `BLOQUEADO`.
- `PRIVACY_AND_LEGAL`: `BLOQUEADO`.
- `RESIDUAL_RISK_ACCEPTANCE`: `BLOQUEADO`.
- Checklist de operación sombra completo: `NO_VERIFICADO`.
- Gate hospedado y SHA coincidente: `NO_VERIFICADO`.
- Ventana y guardia confirmadas: `PENDIENTE`.
- Decisión final: **`NO_INICIADA / BLOQUEADO`**.

Firmas requeridas por rol y fecha: Security/Incident Commander, Privacy/Legal,
Product, Dueño de decisión de Negocio ARCOTEX, Data Owner y Plataforma de
guardia. Hasta disponer de todas y de sus referencias protegidas, la única
acción autorizada es completar evidencia fuera de este repositorio.

## Referencias operativas

- `docs/ARCOTEX_SHADOW_OPERATION_CHECKLIST.md`: prerequisitos, recorrido,
  pausa y cierre de la marcha blanca.
- `docs/ARCOTEX_SHADOW_OPERATION_RECORD_TEMPLATE.md`: acta sanitizada por
  sesión; no completar secciones operativas antes del GO.
- `docs/ARCOTEX_SANITIZED_EVIDENCE_MANIFEST.md`: contrato de integración para
  estado, vigencia, referencia protegida y digest de cada evidencia; se mantiene
  en la rama propietaria hasta su integración en el candidato.
- `docs/PILOT_READINESS_RUNBOOK.md`: gates de promoción, flags y evidencia
  mínima.
- `docs/THREAT_MODEL_CURRENT.md`: riesgos vigentes y owners requeridos.
- `docs/STAGING_ENVIRONMENT.md`: SECURITY HOLD vigente; no usar este paquete
  para acceder, sanear o verificar staging.
