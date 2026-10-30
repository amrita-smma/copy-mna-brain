import { describe, expect, it } from 'vitest';
import { LEGAL_EFFECTIVE_DATE, legalConfig } from './config';

describe('legalConfig', () => {
  it('defaults to StarCapital with no contact or governing law, so nothing is invented', () => {
    expect(legalConfig({} as never)).toEqual({
      productName: 'Investment Brain',
      entityName: 'StarCapital',
      contactEmail: null,
      governingLaw: null,
      effectiveDate: LEGAL_EFFECTIVE_DATE,
    });
  });

  it('reads the operator settings, trimmed', () => {
    const config = legalConfig({
      LEGAL_ENTITY_NAME: ' Acme Capital ',
      LEGAL_CONTACT_EMAIL: ' privacy@acme.example ',
      LEGAL_GOVERNING_LAW: ' the Republic of Indonesia ',
    } as never);
    expect(config).toMatchObject({
      entityName: 'Acme Capital',
      contactEmail: 'privacy@acme.example',
      governingLaw: 'the Republic of Indonesia',
    });
  });

  it('drops a malformed contact address rather than printing a broken mailto', () => {
    for (const bad of ['not-an-email', 'a@b', 'Ana <a@b.com>', '  ']) {
      expect(legalConfig({ LEGAL_CONTACT_EMAIL: bad } as never).contactEmail, bad).toBeNull();
    }
  });
});
