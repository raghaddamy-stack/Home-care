// Consent rules (BRD §5.8 BR-80, with the guardian rule BR-03).

export const CONSENT_TYPES = ['GENERAL_TREATMENT', 'INVASIVE_PROCEDURE', 'IMAGING', 'PHOTOGRAPHY', 'DATA_SHARING_FAMILY', 'GUARDIAN_ACCESS'] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export const CONSENT_METHODS = ['APP', 'OTP', 'ESIGN', 'PAPER'] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

/** Who may sign for the patient. SELF needs an adult with capacity (BR-03). */
export const SIGNER_RELATIONS = ['SELF', 'PARENT', 'SPOUSE', 'CHILD', 'SIBLING', 'LEGAL_GUARDIAN'] as const;
export type SignerRelation = (typeof SIGNER_RELATIONS)[number];

export const ADULT_AGE = 18;

export interface ConsentRecord {
  type: string;
  signed_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export function ageOn(dob: string | null | undefined, at: Date): number | null {
  if (!dob) return null;
  const b = new Date(dob);
  let age = at.getFullYear() - b.getFullYear();
  if (at.getMonth() < b.getMonth() || (at.getMonth() === b.getMonth() && at.getDate() < b.getDate())) age--;
  return age;
}

/** Returns an error message when the signer is not allowed, or null when the signature is valid. */
export function signerError(opts: { patientDob: string | null; relation: SignerRelation; at: Date }): string | null {
  const age = ageOn(opts.patientDob, opts.at);
  if (opts.relation === 'SELF' && age !== null && age < ADULT_AGE) {
    return `Patient is under ${ADULT_AGE}: a guardian must sign the consent (BR-03)`;
  }
  return null;
}

/** True when a non-revoked, non-expired consent of the given type exists at `at`. */
export function hasValidConsent(records: ConsentRecord[], type: ConsentType, at: Date): boolean {
  return records.some((c) =>
    c.type === type &&
    !c.revoked_at &&
    new Date(c.signed_at).getTime() <= at.getTime() &&
    (!c.expires_at || new Date(c.expires_at).getTime() > at.getTime()));
}

/** Consent types a visit needs before the staff may start (BR-80). Imaging also needs its specific consent. */
export function consentsNeededFor(visitKind: string): ConsentType[] {
  return visitKind === 'IMAGING' ? ['GENERAL_TREATMENT', 'IMAGING'] : ['GENERAL_TREATMENT'];
}
