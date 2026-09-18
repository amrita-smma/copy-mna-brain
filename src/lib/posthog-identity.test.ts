import { describe, it, expect } from 'vitest';
import {
  EMAIL_SUPER_PROPERTY,
  SEND_EMAIL_WITH_EVENTS,
  needsIdentify,
  personPropertiesFor,
  superPropertiesFor,
} from './posthog-identity';

describe('personPropertiesFor', () => {
  it('includes email and name when both are present', () => {
    expect(
      personPropertiesFor({ id: 'u-1', email: 'ada@example.com', name: 'Ada' }),
    ).toEqual({ email: 'ada@example.com', name: 'Ada' });
  });

  it('trims surrounding whitespace', () => {
    expect(personPropertiesFor({ id: 'u-1', email: '  ada@example.com ', name: ' Ada ' })).toEqual({
      email: 'ada@example.com',
      name: 'Ada',
    });
  });

  it('omits blank values rather than clobbering the person with empty strings', () => {
    expect(personPropertiesFor({ id: 'u-1', email: '', name: '   ' })).toEqual({});
  });

  it('omits null and undefined values', () => {
    expect(personPropertiesFor({ id: 'u-1', email: null, name: undefined })).toEqual({});
  });

  it('never includes the user id — that is already the distinct id on every event', () => {
    expect(personPropertiesFor({ id: 'u-1', email: 'ada@example.com' })).not.toHaveProperty('id');
    expect(personPropertiesFor({ id: 'u-1', email: 'ada@example.com' })).not.toHaveProperty(
      'user_id',
    );
  });
});

describe('needsIdentify', () => {
  it('is true when PostHog holds an anonymous distinct id', () => {
    expect(needsIdentify('01890a5d-anon-uuid', 'u-1')).toBe(true);
  });

  it('is true when nothing is stored yet', () => {
    expect(needsIdentify(undefined, 'u-1')).toBe(true);
    expect(needsIdentify(null, 'u-1')).toBe(true);
  });

  it('is false once the distinct id already matches the user', () => {
    expect(needsIdentify('u-1', 'u-1')).toBe(false);
  });

  it('is false for an empty user id, so we never identify as ""', () => {
    expect(needsIdentify('anon', '')).toBe(false);
  });
});

describe('superPropertiesFor', () => {
  it('stamps the email so every event carries it alongside the UUID distinct id', () => {
    expect(superPropertiesFor({ id: 'u-1', email: 'ada@example.com' })).toEqual({
      [EMAIL_SUPER_PROPERTY]: 'ada@example.com',
    });
  });

  it('trims the email', () => {
    expect(superPropertiesFor({ id: 'u-1', email: '  ada@example.com ' })).toEqual({
      email: 'ada@example.com',
    });
  });

  it('returns null — meaning unregister — when the user has no usable email', () => {
    expect(superPropertiesFor({ id: 'u-1', email: '' })).toBeNull();
    expect(superPropertiesFor({ id: 'u-1', email: '   ' })).toBeNull();
    expect(superPropertiesFor({ id: 'u-1', email: null })).toBeNull();
    expect(superPropertiesFor({ id: 'u-1' })).toBeNull();
  });

  it('never stamps the id — it is already the distinct id', () => {
    expect(superPropertiesFor({ id: 'u-1', email: 'ada@example.com' })).not.toHaveProperty('id');
  });

  it('is currently switched on', () => {
    // Guards the interim state: when this is flipped off, the assertion below
    // is the reminder that the flag — not a deleted call — is the removal path.
    expect(SEND_EMAIL_WITH_EVENTS).toBe(true);
  });

  it('returns null for everyone once the flag is flipped off', () => {
    // The removal path: flip SEND_EMAIL_WITH_EVENTS, and nobody gets stamped.
    expect(superPropertiesFor({ id: 'u-1', email: 'ada@example.com' }, false)).toBeNull();
    expect(superPropertiesFor({ id: 'u-2', email: 'grace@example.com' }, false)).toBeNull();
  });
});
