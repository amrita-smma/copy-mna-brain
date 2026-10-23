import { describe, expect, it } from 'vitest';
import { isAddressLikeName, pickBetterContactName } from './contactName';

describe('isAddressLikeName', () => {
  it('treats empty, @-bearing and email-equal names as address-like', () => {
    expect(isAddressLikeName('', 'a@b.com')).toBe(true);
    expect(isAddressLikeName('   ', 'a@b.com')).toBe(true);
    expect(isAddressLikeName(null, 'a@b.com')).toBe(true);
    expect(isAddressLikeName('A@B.com', 'a@b.com')).toBe(true);
    expect(isAddressLikeName('someone@else.com', 'a@b.com')).toBe(true);
  });

  it('accepts a real name', () => {
    expect(isAddressLikeName('Jane Doe', 'jane@gs.com')).toBe(false);
  });
});

describe('pickBetterContactName', () => {
  it('replaces an address-like name with a later real name', () => {
    expect(pickBetterContactName('jane@gs.com', 'Jane Doe', 'jane@gs.com')).toBe(
      'Jane Doe',
    );
  });

  it('never replaces a real name with an address-like one', () => {
    expect(pickBetterContactName('Jane Doe', 'jane@gs.com', 'jane@gs.com')).toBe(
      'Jane Doe',
    );
    expect(pickBetterContactName('Jane Doe', '', 'jane@gs.com')).toBe('Jane Doe');
  });

  it('keeps the first of two real names', () => {
    expect(pickBetterContactName('Jane Doe', 'J. Doe', 'jane@gs.com')).toBe(
      'Jane Doe',
    );
  });

  it('falls back to the email when neither side has a name', () => {
    expect(pickBetterContactName(null, '  ', 'jane@gs.com')).toBe('jane@gs.com');
  });
});
