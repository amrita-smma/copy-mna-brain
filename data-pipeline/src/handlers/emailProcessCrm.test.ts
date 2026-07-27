import { describe, expect, it } from 'vitest';
import {
  skipCrmPerson,
  skipEmployerDomain,
} from './emailProcessCrm';

describe('emailProcessCrm domain gates', () => {
  const excluded = new Set(['blocked.example', 'hr-vendor.com']);

  it('skips internal, personal, and curated excluded addresses', () => {
    expect(skipCrmPerson('a@starcapital.co.id', excluded)).toBe(true);
    expect(skipCrmPerson('a@gmail.com', excluded)).toBe(true);
    expect(skipCrmPerson('x@blocked.example', excluded)).toBe(true);
    expect(skipCrmPerson('banker@goldman.com', excluded)).toBe(false);
  });

  it('skips employer creation for excluded domains on To/Cc', () => {
    expect(skipEmployerDomain('blocked.example', excluded)).toBe(true);
    expect(skipEmployerDomain('hr-vendor.com', excluded)).toBe(true);
    expect(skipEmployerDomain('goldman.com', excluded)).toBe(false);
    expect(skipEmployerDomain('gmail.com', excluded)).toBe(true);
  });
});
