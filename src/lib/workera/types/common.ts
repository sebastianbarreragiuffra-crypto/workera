/**
 * Tipos compartidos que deliberadamente NO asumen cómo pagina o filtra la
 * API real de Workera (secciones 16-17 del encargo) — se confirman en
 * Fase 5 y estos tipos no deberían necesitar cambiar cuando eso pase.
 */

/**
 * Fecha calendario local (YYYY-MM-DD), sin componente de hora ni timezone.
 * Representa un "día laboral" en el sentido de docs/PRE_FASE2_WORKERA_VALIDATION.md
 * sección 9 (America/Santiago), NO un instante. Quien construye este valor
 * (la futura capa de sincronización) es responsable de resolverlo con el
 * timezone correcto — este módulo nunca calcula "ayer" con el reloj del
 * entorno de ejecución.
 */
export type LocalDate = string;

export interface LocalDateRange {
  from: LocalDate;
  to: LocalDate;
}

/**
 * Token de paginación opaco. Puede representar un número de página, un
 * offset o un cursor real según lo que confirme la documentación de
 * Workera — el llamador nunca debe interpretar su contenido, solo
 * reenviarlo tal cual a la siguiente llamada.
 */
export type WorkeraPageToken = string;

export interface WorkeraListResult<T> {
  items: T[];
  /** null = no hay más páginas. */
  nextPageToken: WorkeraPageToken | null;
}

export interface WorkeraListOptions {
  pageToken?: WorkeraPageToken;
}
