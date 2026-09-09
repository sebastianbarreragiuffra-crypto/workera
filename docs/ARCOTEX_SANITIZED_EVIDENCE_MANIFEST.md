# Manifiesto sanitizado de evidencias — marcha blanca ARCOTEX

## Propósito

Este manifiesto define el contrato único para reunir y verificar las evidencias
de la marcha blanca de Asistencia sin copiar credenciales, enlaces protegidos,
identificadores personales ni datos reales de trabajadores.

Completar este manifiesto demuestra que el paquete de evidencias está listo
para una decisión humana. No autoriza por sí solo el inicio del piloto, un
despliegue, una migración ni la activación de sincronizaciones.

## Alcance fijo

- Empresa: ARCOTEX.
- Población máxima: 45 trabajadores previamente autorizados.
- Módulo: Asistencia solamente.
- Modalidad: marcha blanca controlada.
- Sincronización externa: `WORKERA_SYNC_ENABLED=false`.
- Fuera de alcance: remuneraciones, automatizaciones, integraciones nuevas,
  cambios en producción y ampliaciones de población.

## Estados permitidos

Cada evidencia usa exactamente uno de estos estados:

- `PENDING`: todavía no existe o no ha sido revisada.
- `VERIFIED`: fue revisada por un rol autorizado y está vigente.
- `FAILED`: no cumple el criterio esperado.
- `EXPIRED`: fue válida, pero superó su ventana de vigencia.

El estado agregado sólo puede ser `EVIDENCE_PACKET_COMPLETE` cuando todas las
evidencias obligatorias están en `VERIFIED`. Ese estado no equivale a `GO`.

## Formato de registro

Por cada evidencia se registra únicamente:

```text
evidence_id: identificador técnico no personal
evidence_type: tipo definido en este documento
owner_role: rol responsable, nunca nombre de persona
generated_at: fecha y hora con zona horaria
expires_at: fecha y hora con zona horaria
protected_reference: referencia interna opaca o NONE
sha256_digest: huella SHA-256 o NONE cuando no corresponda
verifier_role: rol que realizó la comprobación
verified_at: fecha y hora con zona horaria o NONE
status: PENDING | VERIFIED | FAILED | EXPIRED
notes: observación sanitizada, sin datos personales ni secretos
```

`protected_reference` identifica dónde está el original bajo control de
acceso. El manifiesto nunca incluye la evidencia original, tokens, cookies,
URLs firmadas, cabeceras, correos, teléfonos, identificadores de trabajadores
o capturas con información personal.

## Inventario obligatorio

### 1. Candidato de software

- `CANDIDATE_COMMIT`: SHA completo del candidato consolidado.
- `TYPECHECK_RESULT`: resultado vigente del control de tipos.
- `LINT_RESULT`: resultado vigente del análisis estático.
- `TEST_RESULT`: resultado vigente de las pruebas automatizadas.
- `BUILD_RESULT`: resultado vigente de la compilación de producción.
- `DATABASE_TEST_RESULT`: resultado de base de datos ejecutado sólo en un
  entorno local aislado; si no se ejecutó, permanece `PENDING`.

La cantidad de pruebas puede anotarse, pero nunca sustituye la huella del
artefacto ni el SHA del candidato.

### 2. Despliegue y procedencia

- `DEPLOYED_COMMIT`: SHA completo informado por el proveedor de despliegue.
- `DEPLOYMENT_PROVENANCE`: referencia protegida y huella del comprobante de
  despliegue.
- `RUNTIME_CONFIGURATION`: comprobación sanitizada de que la sincronización
  está desactivada y el alcance corresponde solamente a Asistencia.

Los valores de `CANDIDATE_COMMIT` y `DEPLOYED_COMMIT` deben ser idénticos,
tener 40 caracteres hexadecimales y ser verificados por fuentes
independientes. Una etiqueta de rama, texto manual o SHA abreviado no basta.

### 3. Acceso alojado

- `HOSTED_ACCESS_MATRIX`: resultado completo de la matriz de acceso vigente.
- `AAL2_ADMIN_PROOF`: comprobación de segundo factor para el rol administrador.
- `SESSION_AND_LOGOUT_PROOF`: comprobación de expiración y cierre de sesión.
- `API_PROTECTION_PROOF`: comprobación sanitizada de rechazo de acceso no
  autorizado y separación de roles.

La matriz debe registrar cada caso previsto como verificado. Un caso omitido,
fallido o expirado bloquea el paquete completo.

### 4. Preflight de Asistencia

- `ATTENDANCE_PREFLIGHT`: resultado completo del preflight vigente.
- `AUTHORIZED_POPULATION_COUNT`: confirmación de exactamente 45 trabajadores.
- `AUTHORIZED_CODES_CHECK`: confirmación de que todos los registros esperados
  cumplen la condición de autorización definida para el piloto.
- `SCOPE_ISOLATION`: evidencia de que no se habilitaron módulos fuera de
  Asistencia.

Este documento registra resultados agregados. Nunca lista trabajadores,
códigos, documentos, correos ni otros identificadores individuales.

### 5. Puertas humanas

- `INCIDENT_RESPONSE_APPROVAL`: validación del responsable de Seguridad o
  Comandante de Incidentes, incluyendo disponibilidad y escalamiento.
- `PRIVACY_AND_LEGAL_APPROVAL`: determinación formal de Privacidad o Legal
  sobre propósito, minimización, retención y derechos aplicables.
- `RESIDUAL_RISK_ACCEPTANCE`: aceptación explícita de riesgos residuales por
  Negocio, Producto, Datos y Plataforma según corresponda.

Las aprobaciones registran rol, fecha, vigencia, referencia protegida y huella.
No se reemplazan por mensajes informales ni por una evaluación técnica.

### 6. Ensayo y decisión

- `DRY_RUN_RESULT`: ejecución completa del guion de ensayo, incluyendo al
  menos un escenario de detención y recuperación segura.
- `OPERATIONAL_ROSTER`: confirmación de cobertura de roles durante la ventana,
  sin nombres ni datos de contacto en este manifiesto.
- `GO_NO_GO_RECORD`: tarjeta de decisión completada por los cuatro roles
  requeridos.
- `DAY_ZERO_READINESS`: confirmación de que la sala de control y sus canales
  protegidos están disponibles.

La tarjeta `GO_NO_GO_RECORD` es el único registro que puede contener el
resultado humano `GO`, `NO-GO` o `HOLD`. Un manifiesto completo sin esa tarjeta
permanece bloqueado.

## Reglas de conciliación

Antes de declarar `EVIDENCE_PACKET_COMPLETE`, el verificador debe confirmar:

1. Todas las evidencias obligatorias existen y están `VERIFIED`.
2. Ninguna evidencia superó `expires_at`.
3. El SHA del candidato coincide exactamente con el SHA desplegado.
4. Las huellas coinciden con los originales consultados bajo acceso protegido.
5. La población agregada es exactamente 45 y el alcance sigue limitado a
   Asistencia.
6. `WORKERA_SYNC_ENABLED=false` fue comprobado en el entorno objetivo.
7. Las tres puertas humanas están aprobadas y vigentes.
8. El ensayo terminó sin una condición crítica abierta.
9. La tarjeta de decisión contiene las cuatro decisiones requeridas.

Si cualquiera de estas reglas falla, el paquete queda bloqueado. No se permite
inferir una aprobación, reutilizar una evidencia vencida ni completar un campo
con información no verificada.

## Caducidad y cambios

Una evidencia deja de ser válida cuando ocurre cualquiera de estos eventos:

- cambia el SHA candidato o el SHA desplegado;
- se modifica la configuración relevante del entorno;
- cambia la población autorizada o el alcance funcional;
- se actualiza una defensa de acceso o identidad evaluada;
- vence la fecha declarada;
- aparece un incidente o hallazgo que afecte su conclusión.

Ante un cambio, las evidencias dependientes vuelven a `PENDING` y deben
generarse otra vez. No se corrige la huella manualmente.

## Secuencia de uso

1. Cada frente entrega su referencia protegida, huella y resultado sanitizado.
2. Un verificador independiente concilia los datos y completa este manifiesto.
3. Las inconsistencias se devuelven al frente propietario sin copiar el
   contenido sensible.
4. Con el paquete completo, los responsables usan
   `ARCOTEX_GO_NO_GO_DECISION_CARD.md` para decidir.
5. Si el resultado es `GO`, la operación se conduce con
   `ARCOTEX_DAY_ZERO_CONTROL_ROOM.md` y el checklist vigente.

## Documentos relacionados

- `ARCOTEX_SHADOW_OPERATION_CHECKLIST.md`
- `ARCOTEX_SHADOW_OPERATION_RECORD_TEMPLATE.md`
- `ARCOTEX_SHADOW_DRY_RUN_SCRIPT.md`
- `ARCOTEX_GO_NO_GO_DECISION_CARD.md`
- `ARCOTEX_DAY_ZERO_CONTROL_ROOM.md`
- `ARCOTEX_HUMAN_GATES_PACKET.md`, cuando esté integrado en la rama candidata.
