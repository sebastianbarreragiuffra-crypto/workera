# Traspaso: pre-nómina multiempresa

Fecha del punto de control: 2026-09-06  
Rama: `codex/prenomina-marcha-blanca`  
Commit funcional: `ed56f7c` (`feat: scope payroll periods by company`)

## Decisiones confirmadas

- Todo el historial actual de `reporting_periods` corresponde a Arcotex.
- Arcotex será la primera empresa del holding, pero el servicio debe admitir otras empresas con cambios pequeños y aislados.
- Dos empresas pueden usar el mismo rango de fechas sin compartir períodos, estados, archivos, ajustes, aprobaciones ni cierres.
- RR. HH. necesita descargar información actualizada en cuatro ventanas: diaria, semanal (lunes a domingo), quincenal (1–15 o 16–fin de mes) y mensual de remuneraciones (16–15).
- La descarga debe regenerarse desde la información vigente.
- El archivo mensual aprobado y cerrado es el resultado oficial e inmutable.
- No se autorizaron merge, push, despliegue ni cambios productivos.

## Implementado en este punto de control

- `reporting_periods` ahora tiene `company_id`; el historial se migra al UUID de Arcotex.
- El mismo ciclo 16–15 puede existir para empresas distintas, pero no puede solaparse dentro de una misma empresa.
- Las relaciones de versiones, conflictos, aprobaciones y operaciones de cierre validan conjuntamente empresa y período.
- Las políticas de acceso a períodos exigen membresía de la empresa, workspace laboral habilitado, rol de RR. HH. y MFA donde corresponde.
- Los tres caminos SQL que registran un Excel aceptado resuelven el período dentro de la empresa indicada.
- Consultas y transiciones de períodos, aprobación, cierre y descarga cerrada filtran por empresa.
- La interfaz ofrece exactamente cuatro descargas: diaria, semanal, quincenal y mensual 16–15.
- El antiguo enlace `tipo=pago` sigue funcionando como compatibilidad, pero ya no aparece como quinta opción.
- La subida e historial del Excel continúan disponibles para la ventana mensual oficial.

## Evidencia ejecutada sobre el código actual

| Control | Resultado |
|---|---|
| `npx tsc --noEmit` | Aprobado |
| `npm run lint` | Aprobado |
| `npm test` | 1.360 aprobadas, 0 fallidas, 2 omitidas; 1.362 total |
| `npm run build` | Aprobado con Next.js 16.3.3 |
| `npx supabase test db` | 2.487 aprobadas en 104 archivos; 0 fallidas |
| Prueba nueva de alcance por empresa | 18/18 aprobadas |

La prueba completa de Supabase se ejecutó en una instancia local aislada creada para esta rama. Luego se detuvo y se restauró `supabase/config.toml`. La instancia compartida `Workera` no se reinició ni se modificó.

## Pendiente para continuar

1. Permitir subida, reimportación, historial y versionado también para archivos diarios, semanales y quincenales. En este commit esas ventanas son descargas de trabajo regenerables y la subida sigue limitada al mensual.
2. Reemplazar el UUID fijo de Arcotex en las rutas laborales por la empresa activa de la sesión antes de habilitar un segundo workspace.
3. Extender el aislamiento por empresa a las tablas laborales heredadas que todavía dependen del modelo Arcotex único y completar el NO-GO multiempresa documentado en `docs/PLATFORM_MULTI_COMPANY.md`.
4. Convertir las reglas configurables por empresa —horarios, jornada, topes, bono y excepciones— en una plantilla base con ajustes por empresa. Hoy las reglas operativas siguen siendo las de Arcotex.
5. Probar visualmente, con una sesión autenticada, las cuatro descargas y el flujo completo descargar → editar → subir → volver a descargar.
6. Volver a ejecutar y documentar individualmente los 30 simuladores laborales sobre el commit final. No confundirlos con los 55 trabajadores ficticios ni con las 1.362 pruebas automatizadas.
7. Ejecutar el ciclo completo de almacenamiento con archivos ficticios en un entorno aislado. No usar datos ni buckets productivos.

## Punto seguro para retomar

Antes de continuar:

```powershell
git switch codex/prenomina-marcha-blanca
git status --short --branch
git log --oneline -3
```

El siguiente bloque recomendado es el punto 1 de pendientes: generalizar la subida y el versionado para las cuatro frecuencias, conservando el cierre exclusivo del ciclo mensual 16–15. Después deben repetirse TypeScript, lint, pruebas, build y pgTAP aislado antes de crear otro commit.

