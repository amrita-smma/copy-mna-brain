/**
 * The facts the public Privacy Policy and Terms of Service state about who we
 * are. They are deployment settings rather than literals so the operator can
 * correct them without a code change; nothing here is a secret (it is printed
 * on a public page). Read per call from the server environment.
 */

/** When the current text of both documents took effect. Bump it when the text changes. */
export const LEGAL_EFFECTIVE_DATE = '30 October 2026';

export const LEGAL_PRODUCT_NAME = 'Investment Brain';

export interface LegalConfig {
  productName: string;
  /** The organization that operates the service and is responsible for the data. */
  entityName: string;
  /** Where privacy and legal questions go. Null = not configured: the pages say to ask the workspace administrator. */
  contactEmail: string | null;
  /** Optional sentence-ready governing law, e.g. "the Republic of Indonesia". Null = the Terms say nothing specific. */
  governingLaw: string | null;
  effectiveDate: string;
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function legalConfig(env: NodeJS.ProcessEnv = process.env): LegalConfig {
  const contact = clean(env.LEGAL_CONTACT_EMAIL);
  return {
    productName: LEGAL_PRODUCT_NAME,
    entityName: clean(env.LEGAL_ENTITY_NAME) ?? 'StarCapital',
    // A malformed value is dropped rather than printed as a broken mailto link.
    contactEmail: contact && EMAIL_RE.test(contact) ? contact : null,
    governingLaw: clean(env.LEGAL_GOVERNING_LAW),
    effectiveDate: LEGAL_EFFECTIVE_DATE,
  };
}
