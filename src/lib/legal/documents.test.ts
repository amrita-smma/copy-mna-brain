import { describe, expect, it } from 'vitest';
import { GMAIL_COMPOSE_SCOPE, GMAIL_SCOPE, GMAIL_SCOPES } from '@/lib/gmail/config';
import { legalConfig } from './config';
import {
  GOOGLE_API_USER_DATA_POLICY_URL,
  limitedUseStatement,
  privacyPolicy,
  termsOfService,
  type LegalDocument,
} from './documents';

const config = legalConfig({ LEGAL_CONTACT_EMAIL: 'privacy@acme.example' } as never);
const privacy = privacyPolicy(config);
const terms = termsOfService(config);

/** Every string in a document, for "does it say X anywhere" checks. */
function text(doc: LegalDocument): string {
  return [
    doc.title,
    ...doc.intro,
    ...doc.sections.flatMap((s) => [s.title, ...(s.paragraphs ?? []), ...(s.bullets ?? []), ...(s.links ?? []).map((l) => l.href)]),
  ].join('\n');
}

describe('privacyPolicy', () => {
  it('carries Google’s Limited Use statement and links the policy it cites', () => {
    expect(text(privacy)).toContain(
      "Investment Brain's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.",
    );
    expect(limitedUseStatement(config)).toContain('Limited Use requirements');
    expect(text(privacy)).toContain(GOOGLE_API_USER_DATA_POLICY_URL);
  });

  it('names every Gmail scope the app actually requests, so the text cannot drift from the code', () => {
    for (const scope of GMAIL_SCOPES) expect(text(privacy), scope).toContain(scope);
    expect(text(privacy)).toContain(GMAIL_SCOPE);
    expect(text(privacy)).toContain(GMAIL_COMPOSE_SCOPE);
  });

  it('states what the Gmail feature does and does not do', () => {
    const body = text(privacy);
    expect(body).toMatch(/never sends email from your Gmail/);
    expect(body).toMatch(/never reads attachment contents/);
    expect(body).toMatch(/Disconnect/);
    expect(body).toMatch(/train generalized AI/);
    expect(body).toMatch(/do not sell/i);
  });

  it('gives the contact when configured, and points at the administrator when not', () => {
    expect(text(privacy)).toContain('privacy@acme.example');
    const unconfigured = text(privacyPolicy(legalConfig({} as never)));
    expect(unconfigured).toContain('workspace administrator');
    expect(unconfigured).not.toMatch(/@/);
  });

  it('has unique, linkable section ids and a dated, titled header', () => {
    const ids = privacy.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(privacy.title).toBe('Privacy Policy');
    expect(privacy.effectiveDate).toBe(config.effectiveDate);
    for (const s of privacy.sections) expect(s.paragraphs?.length || s.bullets?.length).toBeTruthy();
  });
});

describe('termsOfService', () => {
  it('covers Gmail drafts: nothing is sent until the user sends it', () => {
    const body = text(terms);
    expect(body).toMatch(/saves a draft in your Gmail/);
    expect(body).toMatch(/Nothing is sent until you press Send/);
  });

  it('says AI output is not advice, and names the operator', () => {
    expect(text(terms)).toMatch(/not investment, legal, tax or accounting advice/);
    expect(text(terms)).toContain('StarCapital');
  });

  it('only names a governing law when one is configured', () => {
    expect(text(terms)).not.toMatch(/governed by the laws of/);
    const withLaw = text(termsOfService(legalConfig({ LEGAL_GOVERNING_LAW: 'the Republic of Indonesia' } as never)));
    expect(withLaw).toContain('governed by the laws of the Republic of Indonesia');
  });

  it('has unique section ids', () => {
    const ids = terms.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
