import type { NormalizedAbsenceType } from "./normalized";

/** Igual patrón de inyección de dependencia que EmployeeGroupMappingTable — ver ese archivo para el razonamiento. Vacía por defecto: vocabulario real de Workera sin confirmar. */
export type AbsenceTypeMappingTable = Readonly<Record<string, NormalizedAbsenceType>>;

export const EMPTY_ABSENCE_TYPE_MAPPING: AbsenceTypeMappingTable = Object.freeze({});
