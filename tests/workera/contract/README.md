# Contract tests — Workera (scaffold, no ejecutados todavía)

Estructura preparada para futuros tests de contrato contra la API **real** de Workera (sandbox o producción), una vez existan credenciales verificadas (Fase 5). **No se ejecutan en esta fase** — no hay credenciales reales disponibles, y el encargo de Fase 4 prohíbe explícitamente conectarlas.

## Propósito

A diferencia de los tests unitarios en `src/lib/workera/**/*.test.ts` (que validan schemas/mappers/mock con datos ficticios y corren siempre), un contract test golpea la API real de Workera para confirmar que:

- la forma real del JSON sigue coincidiendo con `types/raw.ts` (una vez que ese archivo se reescriba con la forma confirmada);
- la autenticación configurada sigue siendo válida;
- paginación/filtros de fecha se comportan como lo documentado en `docs/WORKERA_API_REQUIREMENTS.md`.

## Cuándo se activan

Cuando exista:
1. Documentación real de Workera (`docs/WORKERA_API_REQUIREMENTS.md` completo o parcialmente confirmado).
2. Credenciales de un entorno sandbox (nunca producción para tests automatizados).
3. `http-client.ts` implementado.

Hasta entonces, esta carpeta solo contiene este README — no se agregan tests especulativos contra una API que no hemos visto.

## Convención prevista

```
tests/workera/contract/
  employees.contract.test.ts
  attendance.contract.test.ts
  absences.contract.test.ts
```

Cada archivo se saltaría automáticamente (`test.skip` o condición equivalente) si no hay credenciales de sandbox en el entorno, para no romper `npm run test:workera` en CI/desarrollo sin acceso a Workera.
