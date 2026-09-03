-- GESTORA Rendiciones EX-8 (parte 2): viáticos/per diem como gasto especial.
--
-- Mismo criterio que kilometraje (20260902110000): per_diem_days es
-- informativo/trazable, NUNCA la fuente de verdad del monto -- net_amount
-- sigue siendo la columna real, calculada en servidor como
-- per_diem_days * expense_policies.rules.perDiemDailyRate, nunca confiada
-- de un valor enviado por el cliente.
--
-- Deliberadamente separado de kilometraje en su propia migración (en vez de
-- agregarlo a la de parte 1): son conceptos de cálculo distintos (tarifa por
-- unidad de distancia vs. monto fijo por día) y un ítem nunca es los dos a
-- la vez -- mezclarlos en una sola migración habría dificultado revisar
-- cada uno por separado, igual que se documentó en la parte 1.
alter table public.expense_items
  add column per_diem_days numeric(6,2);
alter table public.expense_items
  add constraint expense_items_per_diem_days_chk check (per_diem_days is null or per_diem_days > 0);
alter table public.expense_items
  add constraint expense_items_mileage_xor_per_diem_chk check (
    distance_km is null or per_diem_days is null
  );

comment on column public.expense_items.per_diem_days is
  'Días de viático, si este ítem es un gasto de per diem. Cuando está '
  'presente, net_amount se calculó en servidor multiplicando esto por la '
  'tarifa diaria vigente (expense_policies.rules.perDiemDailyRate) -- nunca '
  'confiado de un monto enviado por el cliente. Mutuamente excluyente con '
  'distance_km: un mismo ítem no puede ser kilometraje y viático a la vez.';
