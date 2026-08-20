export type ActiveLicenseKpiTone = "healthy" | "attention";

export function getActiveLicenseKpiTone(activeLicenseCount: number): ActiveLicenseKpiTone {
  return activeLicenseCount === 0 ? "healthy" : "attention";
}
