-- Fase 3 — 24: completa un vacío de siembra de Fase 2B
--
-- `07_seeds.sql` (Fase 2A) sembró late_arrival_policies (tolerancia 0, todos
-- los días) para los employee_groups que existían EN ESE MOMENTO
-- (ADMINISTRATION, PRODUCTION). `INSTALLATION` recién se agregó en
-- `08_employee_group_installation_and_history.sql` (Fase 2B), después de que
-- esa siembra ya había corrido — por lo tanto INSTALLATION nunca quedó con
-- ninguna fila de late_arrival_policies. Se completa ahora, con el mismo
-- valor por defecto ya documentado y confirmado (tolerancia 0 para todos los
-- grupos y días, docs/BUSINESS_RULES_PRE_PHASE2.md sección 13) — no es una
-- regla nueva ni inventada, es la aplicación del mismo default ya decidido a
-- un grupo que todavía no existía cuando se sembró originalmente.
insert into public.late_arrival_policies (employee_group_id, day_of_week, tolerance_minutes, effective_from)
select eg.id, d.dow, 0, date '2026-01-01'
from public.employee_groups eg
cross join generate_series(0, 6) as d(dow)
where eg.code = 'INSTALLATION'
  and not exists (
    select 1 from public.late_arrival_policies lap
    where lap.employee_group_id = eg.id and lap.day_of_week = d.dow
  );
