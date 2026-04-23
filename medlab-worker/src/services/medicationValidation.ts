export type MedicationValidationCode = "allowed" | "blocked_stupefiant";

export interface MedicationValidationDecision {
  isSelectable: boolean;
  code: MedicationValidationCode;
  reason: string | null;
}

export function buildMedicationValidationDecision(isSelectable: boolean): MedicationValidationDecision {
  if (isSelectable) {
    return {
      isSelectable: true,
      code: "allowed",
      reason: null,
    };
  }

  return {
    isSelectable: false,
    code: "blocked_stupefiant",
    reason: "Ce médicament n’est pas éligible à la prescription en ligne.",
  };
}
