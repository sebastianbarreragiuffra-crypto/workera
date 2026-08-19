# Pre-Fase-8 — Reconciliación de empleados y cumpleaños

Antes de comenzar el layout de Fase 8, se resolvió la limitación descubierta en
Fase 7 (`docs/BUSINESS_RULES_PHASE7.md`, sección 22): la identidad local de
`employees` dependía **exclusivamente** de `employee.code` embebido en
`attendanceData` — un trabajador que nunca genera eventos de marcación (ej.
personal exento de control horario) nunca aparecía en `employees`, sin importar
cuántos días reales se sincronizaran.

## Qué se agregó

- `GET /employee` (endpoint real confirmado, solo lectura) integrado a
  `HttpWorkeraClient` vía `getEmployeeRoster()`/`getAllEmployeeRoster()`, con
  el mismo esquema de validación Zod + minimización de datos que
  `getAttendanceEvents()` (el RUT, fecha de nacimiento, teléfono, dirección y
  correos que trae el roster real **nunca** se copian a la fila normalizada,
  igual que el criterio ya establecido en Fase 6A para `employees.rut`).
- `bootstrapEmployeesFromRoster()` (`src/lib/business-rules/employee-roster-reconciliation.ts`):
  trae el roster completo paginado y crea filas mínimas para cualquier
  `code` que no exista todavía en `employees` — nunca sobrescribe una fila
  existente (mismo criterio exacto que el bootstrap de Fase 6A basado en
  eventos de asistencia).
- `resolveEmployeeByFullName()`: matching por nombre completo **exacto**
  normalizado (mayúsculas + espacios colapsados + sin acentos, vía el nuevo
  módulo compartido `name-matching.ts`) contra el `employees` ya ampliado.
  Compara el nombre concatenado completo (no separado en nombre/apellido)
  porque el roster de Workera reparte el nombre en 4 campos crudos
  (`name`/`secondName`/`lastName`/`secondLastName`) de forma no predecible
  desde afuera. Si no hay **exactamente una** coincidencia, se reporta sin
  resolver — nunca se adivina ni se elige al azar entre ambigüedades.
- `normalizeName()` extraído a un módulo compartido (`name-matching.ts`),
  reutilizado ahora por `import-birthdays.ts`,
  `employee-roster-reconciliation.ts` y disponible para
  `seed-known-schedules.ts`. Mismo comportamiento, sin cambios de resultado
  en los 11 tests preexistentes de `import-birthdays.test.ts`.

## Resultado real de la ejecución

Roster completo real: **97 empleados** (`GET /employee` sin filtrar, 10
páginas). De ellos, 39 ya existían en `employees` (vía bootstrap de eventos
de asistencia, Fase 6A/6B/7); **58 se bootstrapearon recién con esta fase**.

**Claudio Andrés Barrera**: no resuelto. Ningún registro del roster completo
(97/97) contiene el fragmento "Claudio" en ningún campo de nombre, ni la
combinación "Andrés" + "Barrera" en un mismo registro. No es un problema de
formato de nombre (acentos/mayúsculas) — el nombre dado por el encargo no
aparece en absoluto en los datos que devuelve el endpoint confirmado. Posible
causa (no verificable desde este adapter, solo lectura): podría tratarse de
un apodo/nombre corto no reflejado en el roster, o el endpoint podría no
incluir trabajadores en cierto estado (`employeeStatus`) no explorado en esta
fase. **Queda `MANUAL_REVIEW_REQUIRED` — no se creó ni se adivinó ningún
empleado.**

**Michel Mendy**: no resuelto. A diferencia de Claudio, sí hay coincidencias
parciales reales: 2 registros del roster contienen simultáneamente los
fragmentos "Michel" y "Mendy", pero ninguno tiene un nombre completo
normalizado **exactamente igual** a "Michel Mendy" — ambos tienen componentes
de nombre adicionales (nombre(s) y/o apellido(s) extra que el encargo no
menciona). Forzar una coincidencia aquí sería exactamente el tipo de
"parecido" que el encargo prohíbe explícitamente. Con 2 candidatos y sin un
identificador estable adicional (código Workera, RUT) para desambiguar,
**queda `MANUAL_REVIEW_REQUIRED`** — ninguna política de exención se adjuntó.

Ninguna fila se agregó a `employee_time_control_policies` en esta ejecución
real (0 filas, verificado por conteo directo en la base local).

## Reconciliación de cumpleaños (dry run + import real de lo no ambiguo)

Contra el mismo archivo Excel real de Fase 7 (44 filas válidas, 1 fila
`MISSING_DATE`), reejecutando `planBirthdayImport`/`executeBirthdayImport`
**sin modificar su lógica** (Fase 7), ahora contra el `employees` ampliado a
97 filas:

- Ya resueltos previamente (Fase 7): 27
- Nuevos matches exactos (gracias al roster ampliado): 4
- Total resuelto ahora: 31
- Sigue sin resolver: 13 (0 coincidencias exactas incluso con el roster
  completo — no es un problema de identidad de empleado, esas personas
  probablemente requieren revisión manual del nombre en el Excel de RRHH,
  fuera del alcance de esta fase de solo-lectura).
- Ambiguos (2+ coincidencias): 0

Ninguna fila se importó por coincidencia difusa/parcial — todo lo importado
fue un match exacto normalizado único, igual que el criterio de Fase 7.

## Alcance no tocado

- El esquema de base de datos no cambió (se reutilizan `employees`,
  `employee_birthdays`, `employee_time_control_policies`, todas de Fase 7).
- La lógica de `planBirthdayImport`/`executeBirthdayImport` no se modificó —
  solo se ejecutó contra un `employees` más completo.
- `WORKERA_WRITES: 0` — todas las llamadas a Workera en esta fase fueron
  `GET /employee` (nuevo) y `GET /attendanceData` (ya existente, reutilizado
  solo para reconstruir el baseline local antes de medir "qué hay de nuevo").
