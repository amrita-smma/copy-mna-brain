import { describe, it, expect } from 'vitest';
import { possessive, userInitials } from './Profile';

describe('possessive', () => {
  it("adds 's to an ordinary name", () => {
    expect(possessive('Nico')).toBe("Nico's");
    expect(possessive('  Nico Alimin  ')).toBe("Nico Alimin's");
  });

  it("adds a bare apostrophe to a name already ending in s", () => {
    expect(possessive('Chris')).toBe("Chris'");
    expect(possessive('JAMES')).toBe("JAMES'");
  });

  it('falls back to "Your" before the session resolves', () => {
    expect(possessive('')).toBe('Your');
    expect(possessive('   ')).toBe('Your');
  });
});

describe('userInitials', () => {
  it('takes the first letter of the first two name words', () => {
    expect(userInitials('Nico Alimin', 'nico@example.com')).toBe('NA');
    expect(userInitials('Nico van der Berg', 'nico@example.com')).toBe('NV');
    expect(userInitials('Nico', 'nico@example.com')).toBe('N');
  });

  it('falls back to the email when there is no name', () => {
    expect(userInitials('', 'nico.alimin@example.com')).toBe('NA');
    expect(userInitials('   ', 'nico@example.com')).toBe('NE');
  });

  it('falls back to a placeholder when there is neither', () => {
    expect(userInitials('', '')).toBe('?');
  });
});
