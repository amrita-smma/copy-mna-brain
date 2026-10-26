import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GENERIC_MAILBOX_WORDS,
  isAddressLikeName,
  nameFromEmailLocalPart,
  pickBetterContactName,
} from './contactName';

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

describe('nameFromEmailLocalPart', () => {
  it('spells a name out of a first.last address', () => {
    expect(nameFromEmailLocalPart('matthieu.simoncini@kaditapartners.com')).toBe('Matthieu Simoncini');
    expect(nameFromEmailLocalPart('April.Ng@kaditapartners.com')).toBe('April Ng');
    expect(nameFromEmailLocalPart('keita_takahashi@jp.kpmg.com')).toBe('Keita Takahashi');
    expect(nameFromEmailLocalPart('jean-paul-dupont@firm.fr')).toBe('Jean Paul Dupont');
  });

  it('ignores a +tag', () => {
    expect(nameFromEmailLocalPart('nan.wu+deals@wsp.com')).toBe('Nan Wu');
  });

  it('returns null for an address that is not shaped like a person', () => {
    expect(nameFromEmailLocalPart('christabellel@quillionrealestate.com')).toBeNull();
    expect(nameFromEmailLocalPart('j.smith@gs.com')).toBeNull();
    expect(nameFromEmailLocalPart('john.smith2@gs.com')).toBeNull();
    expect(nameFromEmailLocalPart('a.b.c.d@gs.com')).toBeNull();
    expect(nameFromEmailLocalPart(null)).toBeNull();
    expect(nameFromEmailLocalPart('')).toBeNull();
  });

  it('returns null for a shared mailbox', () => {
    expect(nameFromEmailLocalPart('proposal@northcroft.sg')).toBeNull();
    expect(nameFromEmailLocalPart('deal.team@gs.com')).toBeNull();
    expect(nameFromEmailLocalPart('investor.relations@firm.com')).toBeNull();
    expect(nameFromEmailLocalPart('no-reply@firm.com')).toBeNull();
  });

  it('uses the same mailbox words as the repair migration', () => {
    const migration = readFileSync(
      join(process.cwd(), 'drizzle/migrations/20261026000001_derive_contact_names_from_email.sql'),
      'utf8',
    );
    const list = migration.match(/ARRAY\[([\s\S]*?)\]::text\[\]/)?.[1] ?? '';
    const words = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(new Set(words)).toEqual(new Set(GENERIC_MAILBOX_WORDS));
  });
});
