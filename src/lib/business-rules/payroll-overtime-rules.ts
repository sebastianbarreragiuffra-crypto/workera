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

  if (input.realMinutes < 0 || (input.approvedMinutes !== null && input.approvedMinutes !== undefined && input.approvedMinutes < 0)) {
    return {
      rate: sunday || input.isHoliday ? "HH100" : "HH50",
      realMinutes,
      payableMinutes: 0,
      bonusClp: 0,
      blocked: true,
      warnings: ["Los minutos reales o aprobados no pueden ser negativos."],
    };
  }

  if (input.area === "ADMINISTRATION") {
    return { rate: null, realMinutes, payableMinutes: 0, bonusClp: 0, blocked: realMinutes > 0, warnings: realMinutes > 0 ? ["Administración no tiene regla automática de horas extra."] : [] };
  }
  if (sunday && input.area !== "INSTALLATION") {
    return { rate: "HH100", realMinutes, payableMinutes: 0, bonusClp: 0, blocked: realMinutes > 0, warnings: realMinutes > 0 ? ["Producción en domingo está bloqueada."] : [] };
  }

  const rate = sunday || input.isHoliday ? "HH100" : "HH50";
  if (realMinutes > 0 && realMinutes < 60) {
    warnings.push("Menos de una hora real: no es pagable aunque exista aprobación.");
    return { rate, realMinutes, payableMinutes: 0, bonusClp: 0, blocked: true, warnings };
  }
  if (input.approvedMinutes === null || input.approvedMinutes === undefined) {
    if (realMinutes > 0) warnings.push("Falta aprobación competente.");
    return { rate, realMinutes, payableMinutes: 0, bonusClp: 0, blocked: realMinutes > 0, warnings };
  }

  const approved = Math.max(0, Math.trunc(input.approvedMinutes));
  if (approved > 0 && approved < 60) {
    warnings.push("Menos de una hora aprobada: no es pagable.");
    return { rate, realMinutes, payableMinutes: 0, bonusClp: 0, blocked: true, warnings };
  }
  const cap = sunday ? Number.POSITIVE_INFINITY : input.isHoliday ? 360 : 120;
  const payableMinutes = Math.min(realMinutes, approved, cap);
  if (approved > realMinutes) warnings.push("La aprobación supera las horas reales y fue limitada.");
  if (realMinutes > cap) warnings.push(`Las horas reales superan el tope pagable de ${cap / 60} hora(s).`);
  return {
    rate,
    realMinutes,
    payableMinutes,
    bonusClp: payableMinutes >= 120 ? 1_000 : 0,
    blocked: false,
    warnings,
  };
}
