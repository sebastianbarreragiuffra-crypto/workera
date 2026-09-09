# Centro de control Día 0 — marcha blanca de asistencia ARCOTEX

## Estado inicial

Este runbook coordina la primera ventana después de una decisión
`GO_SHADOW_ARCOTEX` válida. No concede el GO, no cambia staging y no reemplaza
`ARCOTEX_GO_NO_GO_DECISION_CARD.md`.

Si el mensaje canónico de GO, sus cuatro firmas o cualquiera de sus tres SHA no
pueden verificarse al comenzar, el Día 0 termina como `NO_INICIADO`.

## Resultado permitido

El Día 0 puede cerrar solamente como:

- `VENTANA_ABIERTA`: se autoriza comenzar la revisión humana del primer día;
- `PAUSADA`: hubo una condición de pausa después de abrir el centro de control;
- `NO_INICIADO`: faltó una condición de entrada y no se abrió la revisión.

Ningún resultado autoriza remuneraciones, sincronización, automatización,
integraciones, otras empresas o decisiones laborales.

## Sala y canales

Antes de la ventana, definir en una ubicación protegida:

- canal operativo: coordinación breve, sin datos personales;
- canal de incidente: acceso limitado a Plataforma y Security/Privacy;
- repositorio de evidencia: referencias, firmas y agregados sanitizados;
- llamada de decisión: solo roles designados y suplentes;
- contacto de pausa: accesible durante toda la ventana.

No usar chats públicos, correo personal, capturas ni grabaciones. No pegar
consolas, URLs privadas, cuerpos HTTP, identificadores o filas.

## Roles en línea

- **Comandante de ventana — Plataforma:** controla reloj, SHA y estado.
- **Control de acceso — Security/Privacy:** AAL2, mínimo privilegio y exposición.
- **Líder funcional — RR. HH.:** conduce la revisión humana.
- **Contraparte — Supervisor:** valida el proceso de asistencia.
- **Decisor — Negocio ARCOTEX:** mantiene o retira aceptación operativa.
- **Registro — Secretario:** conserva solo decisiones y métricas agregadas.

Cada rol confirma titular y suplente. Una ausencia al inicio produce
`NO_INICIADO`; una ausencia durante la ventana produce `PAUSADA`.

## T-30 a T-20 — congelar la ventana

El comandante registra por referencia protegida:

- [ ] `DECISION_ID` vigente;
- [ ] inicio y fin de la ventana con zona horaria;
- [ ] `CANDIDATE_SHA`, `DEPLOYED_SHA` y `GATE_SHA`, completos e idénticos;
- [ ] hora y fuente independiente de `DEPLOYED_SHA`;
- [ ] ausencia de redespliegues posteriores;
- [ ] rama candidata y upstream limpios;
- [ ] cuatro firmas presentes.

No copiar el contenido de la evidencia a esta acta. Si alguna comprobación no
es binaria o requiere interpretación, registrar `NO_INICIADO`.

## T-20 a T-15 — confirmar el perímetro

Plataforma y Security/Privacy confirman verbalmente:

- [ ] único tenant operativo: ARCOTEX;
- [ ] único módulo: Asistencia;
- [ ] padrón esperado: 45 personas autorizadas;
- [ ] `WORKERA_SYNC_ENABLED=false`;
- [ ] sin importación, reparación ni reproceso durante la ventana;
- [ ] sin remuneraciones, pagos o decisiones automáticas;
- [ ] correo, WhatsApp, OCR, contabilidad, Rendiciones y otros proveedores fuera;
- [ ] rollback operativo entendido: detener revisión y preservar evidencia.

No cambiar un flag para hacer coincidir esta lista. Una diferencia se resuelve
fuera de la ventana y requiere nueva decisión.

## T-15 a T-10 — comprobar personas y acceso

Cada participante responde por su cuenta personal:

- [ ] identidad y rol esperados;
- [ ] AAL2 confirmado por el servidor;
- [ ] acceso solo al tenant y funciones requeridas;
- [ ] canal de pausa disponible;
- [ ] sin cuenta compartida ni sesión administrativa para la revisión.

Security/Privacy registra únicamente rol, `APROBADO/FALLIDO` y hora. Una sesión
AAL1, un rol excesivo o una identidad no esperada produce `NO_INICIADO`.

## T-10 a T-5 — leer el gate y el preflight

Sin reejecutar ni alterar sistemas, los dueños presentan resultados ligados al
mismo SHA y ventana:

- [ ] `ARCOTEX_LABOR_PILOT = GO`;
- [ ] 10/10 casos hospedados aprobados;
- [ ] salida sanitizada sin PII ni material sensible;
- [ ] `READY_FOR_SHADOW_REVIEW`;
- [ ] semana lunes-domingo cerrada y seleccionada por el control;
- [ ] sincronización 7/7 y motor `SUCCEEDED` 7/7;
- [ ] 45 vinculadas, cero ambiguas y cero faltantes;
- [ ] `authorizedCodesMatch: true`;
- [ ] conteos agregados congelados.

Un resultado histórico, local, parcial o de otro SHA equivale a `FALLIDO`.

## T-5 a T-0 — ensayo de pausa

El comandante anuncia: “simulación de SHA divergente”. Cada rol debe:

1. responder `PAUSA`;
2. detener su siguiente acción;
3. indicar su canal de escalamiento;
4. confirmar que no borrará ni copiará evidencia.

El secretario registra seis respuestas. Si falta una, el resultado es
`NO_INICIADO`. Luego el comandante declara explícitamente finalizada la
simulación; nunca se deja una pausa ambigua.

## T0 — doble confirmación

En orden, cada rol responde con una sola palabra:

1. Plataforma: `ABRIR` o `DETENER`.
2. Security/Privacy: `ABRIR` o `DETENER`.
3. RR. HH.: `ABRIR` o `DETENER`.
4. Supervisor: `ABRIR` o `DETENER`.
5. Negocio: `ABRIR` o `DETENER`.

El secretario no vota. Cinco `ABRIR` y todos los controles anteriores permiten
registrar `VENTANA_ABIERTA`. Cualquier otra combinación produce `NO_INICIADO`.

## T+0 a T+15 — primer control de navegación

Solo con `VENTANA_ABIERTA`, RR. HH. y Supervisor:

- abren el dashboard ARCOTEX;
- confirman visualmente fecha y semana autorizadas;
- navegan al primer día sin ejecutar una decisión ni abrir datos fuera del
  flujo acordado;
- confirman que el estado mostrado coincide con los agregados congelados;
- informan únicamente `COINCIDE` o `PAUSA`.

No se descarga XLSX en este paso. No se corrige un caso, no se prueba un botón
de aprobación y no se fuerza una consulta si la interfaz falla.

## T+15 — traspaso a revisión diaria

El comandante entrega al líder funcional:

- estado `VENTANA_ABIERTA`;
- `DECISION_ID` y referencias protegidas;
- semana y primer día autorizados;
- conteos agregados de apertura;
- canal y frase de pausa;
- hora límite de la ventana.

RR. HH. acusa recibo. Desde ese momento aplica la sección “recorrido diario en
sombra” de `ARCOTEX_SHADOW_OPERATION_CHECKLIST.md`.

## Monitoreo durante la ventana

Plataforma observa únicamente señales agregadas acordadas:

- disponibilidad y errores por categoría sanitizada;
- frescura y estado de las siete corridas existentes;
- conteos de casos al inicio y cierre;
- alertas disparadas, recibidas y atendidas;
- vigencia de SHA, AAL2, ventana y responsables.

No instrumentar una señal nueva durante la ventana. Una métrica ausente se
trata como `NO_VERIFICADO` y activa pausa cuando sea condición del GO.

## Pausa inmediata

Cualquier participante dice `PAUSA ARCOTEX`. El comandante confirma en voz
alta y el equipo:

1. deja de navegar o descargar;
2. cierra sesiones según el procedimiento acordado;
3. preserva referencias y agregados ya registrados;
4. asigna owner del incidente;
5. emite `NO_GO_SHADOW_ARCOTEX` con categoría sanitizada;
6. no reanuda dentro de la misma `DECISION_ID`.

No se borra evidencia, no se cambia staging, no se reintenta repetidamente y no
se continúa “solo para terminar el día”.

## Cierre del Día 0

El secretario registra:

```text
Resultado: VENTANA_ABIERTA | PAUSADA | NO_INICIADO
Decision ID: <referencia protegida>
Roles presentes: <seis estados, sin nombres>
SHA coincidentes: SI | NO | NO_VERIFICADO
Gate hospedado: APROBADO | FALLIDO | NO_VERIFICADO
Preflight: READY_FOR_SHADOW_REVIEW | OTRO | NO_VERIFICADO
Semana: <inicio y fin, sin datos de personas>
Ensayo de pausa: 6/6 | INCOMPLETO
Navegación inicial: COINCIDE | PAUSA | NO_EJECUTADA
Incidentes abiertos: <conteo agregado>
Próxima acción: <revisión diaria | nueva decisión | investigación>
```

El cierre del Día 0 no modifica la decisión global del piloto ni convierte la
revisión en un proceso de remuneraciones.
