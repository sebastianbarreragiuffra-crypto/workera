# Auditoría de preparación para marcha blanca — 7 de septiembre de 2026

## Decisión

**NO-GO para una marcha blanca con datos reales.** El candidato está sano para
desarrollo local aislado con datos sintéticos, pero staging todavía requiere
saneamiento, verificación de configuración hospedada y controles operacionales.

No fue necesario invitar a una segunda persona para esta auditoría. El MFA del
OWNER actual ya tiene evidencia hospedada; la prueba multirol y el ejercicio de
recuperación son gates posteriores y deben usar cuentas personales o
desechables, nunca compartir la cuenta del OWNER.

## Candidato auditado

- Rama: `codex/marcha-blanca-readiness-audit`.
- Base del código auditado: `e6bd3dd`.
- Base remota al iniciar: `origin/master` en `b7403ac`; la rama no estaba detrás.
- Última migración incorporada por esta auditoría:
  `20260907110000_supporting_document_cleanup_health_volatility.sql`.
- Datos utilizados: ficticios en local; staging se consultó únicamente mediante
  conteos agregados de solo lectura.

## Hallazgos corregidos

1. Tres pruebas pgTAP mezclaban el rol `service_role` con inspecciones directas
   de tablas o funciones reservadas a `authenticated`. El endurecimiento de
   permisos era correcto; se corrigieron los fixtures sin conceder privilegios
   adicionales.
2. `get_supporting_document_cleanup_health(integer)` dependía de
   `clock_timestamp()` pero estaba declarada `STABLE`. Se agregó una migración
   posterior al historial existente para marcarla `VOLATILE`, evitando que una
   consulta prolongada reutilice métricas antiguas.
3. Se agregó una prueba que confirma la volatilidad correcta y preserva la
   frontera de permisos: solo `service_role` ejecuta el snapshot global.

## Evidencia local

- Instalación reproducible: `npm ci`, 397 paquetes, 0 vulnerabilidades
  reportadas.
- TypeScript: aprobado.
- ESLint: aprobado.
- Tests de aplicación: 1.408 totales; 1.406 aprobados, 0 fallidos y 2 omitidos.
- Build Next.js 16.3.3: aprobado; 41 páginas estáticas generadas.
- Supabase: pila exclusiva `workera-readiness-audit-pc2`, puertos 5842x; no se
  usó ni reinició la pila compartida.
- Reconstrucción desde cero: todas las migraciones aplicadas hasta
  `20260907110000`.
- pgTAP: 110 archivos, 2.550 verificaciones, 0 fallas.
- Lint de base a nivel warning: sin errores ni advertencias.
- Readiness local: `LOCAL_SYNTHETIC` GO, 3/3 gates cerrados.

## Simuladores de pre-nómina

La ejecución base de los 30 simuladores no encontró reglas fallidas:

- 21 aprobados directamente;
- 9 parciales;
- 0 fallidos;
- 0 no ejecutados.

Los nueve parciales exigen evidencia complementaria que no se debe fingir con
mocks: inspección visual, políticas/RLS, persistencia, Storage, concurrencia o
ciclo completo de cierre y reapertura. Existe evidencia histórica 30/30 en
`docs/HANDOFF_PRENOMINA_MULTIEMPRESA.md`, pero esta auditoría conserva separados
el resultado ejecutado ahora y la evidencia de una corrida anterior.

## Preflight de staging

El comando de inventario agregado terminó en `CONFIGURATION_DRIFT`:

- controles seguros declarados en `.env.staging`: 0/15;
- empresas: 3;
- perfiles: 2;
- fichas técnicas en toda la base: 98 (no constituyen ni amplían el padrón de
  ARCOTEX; el alcance operativo autorizado de ARCOTEX es de 45 personas);
- filas que requieren clasificación: 100;
- documentos, aprobaciones médicas, rendiciones, comprobantes y transacciones
  bancarias del inventario: 0.

Estos conteos no demuestran que una fila sea sintética. Tampoco prueban por sí
solos los valores activos en Vercel: el panel hospedado debe compararse con la
matriz segura antes de cualquier habilitación.

## Estado de readiness

- `LOCAL_SYNTHETIC`: **GO** (3/3).
- `SANITIZED_STAGING`: **NO-GO** (4/9).
- `ARCOTEX_LABOR_PILOT`: **NO-GO** (4/18).
- `EXPENSES_PILOT`: **NO-GO** (4/17).
- `MULTI_COMPANY_PRODUCTION`: **NO-GO** (4/20).

MFA hospedado está cerrado para el OWNER actual. Siguen abiertos, entre otros:
clasificación/saneamiento de staging, controles de Auth hospedados, recuperación
break-glass, observabilidad y alertas, restore DB+Storage, canarios de
proveedores, DAST/pentest multirol, carga/soak, respuesta a incidentes,
privacidad/legal y aceptación formal del riesgo residual.

## Próxima acción recomendada

1. Privacy/Platform deben clasificar las 100 filas y autorizar su eliminación,
   anonimización o conservación con controles equivalentes a producción.
2. Comparar los 15 flags con las variables reales del despliegue hospedado y
   mantener apagados Workera y todos los canales/proveedores no ensayados.
3. Repetir el inventario hasta obtener un staging exclusivamente sintético.
4. Después ejecutar la matriz hospedada con cuentas separadas de mínimo
   privilegio: OWNER, RR. HH., supervisor y usuario sin privilegios.
5. Ejecutar recuperación MFA con una cuenta desechable, nunca con el único
   OWNER real.

No aplicar migraciones, borrar datos ni habilitar integraciones basándose solo
en este informe. Esas acciones requieren una ventana de cambio, respaldo y
autorización explícita del responsable del ambiente.
