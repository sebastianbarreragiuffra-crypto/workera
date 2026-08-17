/**
 * ⚠️ PLACEHOLDER ESPECULATIVO — NO ES UN CONTRATO CONFIRMADO DE WORKERA. ⚠️
 *
 * No existe documentación ni acceso real a la API de Workera en este
 * repositorio (confirmado: no hay ningún archivo de documentación de
 * Workera bajo `docs/` más allá de nuestro propio análisis interno). Estos
 * tipos existen ÚNICAMENTE para poder construir y testear el pipeline
 * schema → mapper → modelo normalizado antes de tener acceso real, y para
 * darle una forma concreta a `MockWorkeraClient`.
 *
 * Cuando exista documentación real (Fase 5, ver
 * docs/WORKERA_API_REQUIREMENTS.md), este archivo se REEMPLAZA por
 * completo — nombres de campo, tipos, nesting, todo. No se debe asumir que
 * ningún nombre de campo aquí (snake_case, ids, etc.) sobrevivirá el
 * reemplazo. `WAITING_FOR_WORKERA_DOCUMENTATION`.
 *
 * Los schemas de `schemas/` validan exactamente esta forma placeholder, no
 * una forma real. `MockWorkeraClient` es el único productor legítimo de
 * estos tipos hasta Fase 5.
 */

export interface RawWorkeraEmployee {
  id: string;
  rut?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  active?: boolean | null;
  /** Nombre de grupo/área tal como lo entregaría Workera — vocabulario real desconocido, ver mappers/employee-group.ts. */
  group?: string | null;
}

export interface RawWorkeraAttendanceRecord {
  employee_id: string;
  /** Fecha calendario, forma/timezone reales sin confirmar (sección 18 del encargo). */
  date: string;
  clock_in?: string | null;
  clock_out?: string | null;
  record_id?: string | null;
  updated_at?: string | null;
  /** Especulativo: no sabemos si Workera expone un código de estado diario análogo a P/F/V/L. */
  status_code?: string | null;
}

export interface RawWorkeraAbsenceRecord {
  employee_id: string;
  /** Vocabulario real de tipos (¿"VACATION"? ¿"vacaciones"? ¿un código numérico?) sin confirmar. */
  type: string;
  start_date: string;
  end_date: string;
  record_id?: string | null;
}
