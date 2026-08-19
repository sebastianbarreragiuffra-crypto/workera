-- Fase 7 — extensión de GRANTs para `service_role` (mismo hallazgo real de
-- Fase 6A: `service_role` tiene BYPASSRLS pero ninguna migración le otorgó
-- privilegios de tabla más allá de lo ya concedido en 20260818190000). Los
-- motores nuevos de Fase 7 (resolveEffectiveSchedule, derivador diario,
-- generadores de atraso/salida anticipada/overtime) corren server-only bajo
-- `service_role` -- mismo criterio que el pipeline de sync de Fase 6A/6B, ya
-- que las tablas de hechos calculados (attendance_records/
-- late_arrival_records/overtime_records) tienen CERO grant de escritura
-- para `authenticated` por diseño (sección 33 del encargo de Gate D: "no
-- permitir que un cliente manipule candidate_minutes").
--
-- Alcance: EXACTAMENTE lo que los servicios de src/lib/business-rules/
-- necesitan leer/escribir, no más. El mismo vacío sigue existiendo en el
-- resto del esquema (documentado desde Fase 6A) y continúa fuera de
-- alcance corregirlo de forma integral aquí.
grant select on public.employee_groups to service_role;
grant select, insert, update on public.employee_time_control_policies to service_role;
grant select, insert, update on public.schedule_assignments to service_role;
grant select, insert, update on public.work_schedules to service_role;
grant select, insert, update on public.work_schedule_rules to service_role;
grant select on public.late_arrival_policies to service_role;
grant select on public.overtime_policies to service_role;
grant select on public.overtime_types to service_role;

grant select, insert, update on public.attendance_records to service_role;
grant select, insert, update on public.late_arrival_records to service_role;
grant select, insert, update on public.overtime_records to service_role;

-- src/lib/business-rules/seed-known-schedules.ts (Fase 7, PASO 5-8): seed
-- administrativo único que resuelve nombres reales -> employee_id y crea
-- horarios individuales/exenciones -- corre bajo service_role igual que el
-- resto de herramientas administrativas de este proyecto (ej. el pipeline
-- de sync), aunque work_schedules/work_schedule_rules/schedule_assignments
-- ya tenían GRANT completo para `authenticated` desde Fase 3 (RLS exige
-- is_privileged_admin() de todas formas en ambos casos).
