export type PayrollArea = "PRODUCTION" | "INSTALLATION" | "ADMINISTRATION";

export interface PayrollOvertimeInput {
  area: PayrollArea;
  realMinutes: number;
  dayOfWeek: number;
  isHoliday: boolean;
  approvedMinutes?: number | null;
}

export interface PayrollOvertimeResult {
  rate: "HH50" | "HH100" | null;
  realMinutes: number;
  payableMinutes: number;
  bonusClp: number;
  blocked: boolean;
  warnings: string[];
}

/** Regla única, pura y auditable para la marcha blanca de pre-nómina. */
export function evaluatePayrollOvertime(input: PayrollOvertimeInput): PayrollOvertimeResult {
  const realMinutes = Math.max(0, Math.trunc(input.realMinutes));
  const sunday = input.dayOfWeek === 0;
  const warnings: string[] = [];

  if (input.area === "ADMINISTRATION") {
    return { rate: null, realMinutes, payableMinutes: 0, bonusClp: 0, blocked: realMinutes > 0, warnings: realMinutes > 0 ? ["Administración no tiene regla automática de horas extra."] : [] };
  }
  if (sunday && input.area !== "INSTALLATION") {
    return { rate: "HH100", realMinutes, payableMinutes: 0, bonusClp: 0, blocked: realMinutes > 0, warnings: realMinutes > 0 ? ["Producción en domingo está bloqueada."] : [] };
  }

  const rate = sunday || input.isHoliday ? "HH100" : "HH50";
  if (realMinutes > 0 && realMinutes < 60) warnings.push("Menos de una hora: no es pagable automáticamente.");
  if (input.approvedMinutes === null || input.approvedMinutes === undefined) {
    if (realMinutes > 0) warnings.push("Falta aprobación competente.");
    return { rate, realMinutes, payableMinutes: 0, bonusClp: 0, blocked: realMinutes > 0, warnings };
  }

  const approved = Math.max(0, Math.trunc(input.approvedMinutes));
  const cap = sunday ? Number.POSITIVE_INFINITY : input.isHoliday ? 360 : 120;
  const payableMinutes = Math.min(realMinutes, approved, cap);
  if (approved > realMinutes) warnings.push("La aprobación supera las horas reales y fue limitada.");
  if (realMinutes > cap) warnings.push(`Las horas reales superan el tope pagable de ${cap / 60} hora(s).`);
  if (payableMinutes < 60 && realMinutes > 0) warnings.push("El tiempo aprobado es inferior a una hora.");
  return {
    rate,
    realMinutes,
    payableMinutes,
    bonusClp: payableMinutes >= 120 ? 1_000 : 0,
    blocked: false,
    warnings,
  };
}
