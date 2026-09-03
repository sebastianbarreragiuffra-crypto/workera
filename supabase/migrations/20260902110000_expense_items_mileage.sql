-- GESTORA Rendiciones EX-8 (parte 1): kilometraje como gasto especial.
--
-- Alcance acotado: solo kilometraje esta pasada (viáticos/per diem queda
-- para una parte 2 separada -- es un concepto distinto, monto fijo por día
-- en vez de tarifa por unidad, y mezclar ambos en una sola migración
-- dificultaría revisar cada uno por separado).
--
-- distance_km es informativo/trazable, NUNCA la fuente de verdad del monto:
-- net_amount sigue siendo la columna NOT NULL de siempre. Cuando la persona
-- carga distancia, el servidor (nunca el cliente) recalcula net_amount =
-- distance_km * expense_policies.rules.mileageRatePerKm vigente -- mismo
-- criterio que el resto del esquema (Workera resuelve company_id en
-- servidor, submit_expense_report recalcula required_approval_steps, etc.):
-- un monto que determina cuánto se le paga a alguien nunca se confía tal
-- cual de un cálculo hecho en el navegador.
alter table public.expense_items
  add column distance_km numeric(10,2);
alter table public.expense_items
  add constraint expense_items_distance_km_chk check (distance_km is null or distance_km > 0);

comment on column public.expense_items.distance_km is
  'Kilómetros recorridos, si este ítem es un gasto de kilometraje. Cuando '
  'está presente, net_amount se calculó en servidor multiplicando esto por '
  'la tarifa vigente (expense_policies.rules.mileageRatePerKm) -- nunca '
  'confiado de un monto enviado por el cliente para este caso.';
