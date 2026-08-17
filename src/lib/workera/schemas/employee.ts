import { z } from "zod";

/**
 * Valida la forma de types/raw.ts#RawWorkeraEmployee. Ver la advertencia en
 * ese archivo — esta forma es especulativa, no un contrato confirmado.
 */
export const rawWorkeraEmployeeSchema = z.object({
  id: z.string().min(1, "id no puede ser vacío"),
  rut: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  full_name: z.string().nullish(),
  active: z.boolean().nullish(),
  group: z.string().nullish(),
});

export const rawWorkeraEmployeeListSchema = z.array(rawWorkeraEmployeeSchema);
