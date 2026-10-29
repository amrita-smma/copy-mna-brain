import { describe, it, expect } from 'vitest';
import { possessive, resolveProfileTab, userInitials } from './Profile';

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

describe('resolveProfileTab', () => {
  it('opens the tab named in the URL', () => {
    expect(resolveProfileTab('items', true)).toBe('items');
    expect(resolveProfileTab('memory', true)).toBe('memory');
    expect(resolveProfileTab('apps', true)).toBe('apps');
    // Connected apps does not depend on the Memory tab being available.
    expect(resolveProfileTab('apps', false)).toBe('apps');
  });

  it('opens on the first tab when the URL says nothing', () => {
    expect(resolveProfileTab(null, true)).toBe('you');
    expect(resolveProfileTab(undefined, true)).toBe('you');
    expect(resolveProfileTab('', true)).toBe('you');
  });

  it('falls back to the first tab for one that does not exist', () => {
    expect(resolveProfileTab('settings', true)).toBe('you');
    expect(resolveProfileTab('MEMORY', true)).toBe('you');
  });

  it('opens Your Profile regardless of the memory flag', () => {
    // It is account details, not memory — switching memory off must not hide it.
    expect(resolveProfileTab('you', true)).toBe('you');
    expect(resolveProfileTab('you', false)).toBe('you');
  });

  it('falls back to a tab that exists when Memory is not available', () => {
    // A bookmark kept from before memory was switched off, or a link shared
    // with someone whose deployment never had it.
    expect(resolveProfileTab('memory', false)).toBe('you');
  });
});
