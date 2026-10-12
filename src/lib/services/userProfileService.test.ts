import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  UserProfileInvalidError,
  UserProfileNotFoundError,
  UserProfileService,
} from './userProfileService';

const USER = 'user-1';

const users = {
  findProfile: vi.fn(),
  updateProfile: vi.fn(),
};

const row = {
  id: USER,
  name: 'Nur Khairusy',
  email: 'nur@example.com',
  nickname: 'Nur',
  phone_code: '+62',
  phone: '8123456789',
  job_title: 'Investment Associate',
  how_brain_helps: 'Screens inbound deals faster.',
};

const service = () => new UserProfileService(users as never);

beforeEach(() => {
  vi.clearAllMocks();
  users.findProfile.mockResolvedValue(row);
  users.updateProfile.mockResolvedValue(row);
});

describe('UserProfileService.get', () => {
  it('maps the row onto the form shape', async () => {
    expect(await service().get(USER)).toEqual({
      id: USER,
      fullName: 'Nur Khairusy',
      email: 'nur@example.com',
      nickName: 'Nur',
      phoneCode: '+62',
      phone: '8123456789',
      jobTitle: 'Investment Associate',
      howBrainHelps: 'Screens inbound deals faster.',
    });
  });

  it('turns nulls into empty strings so the form stays controlled', async () => {
    users.findProfile.mockResolvedValue({
      ...row,
      nickname: null,
      phone_code: null,
      phone: null,
      job_title: null,
      how_brain_helps: null,
    });

    const profile = await service().get(USER);

    expect(profile.nickName).toBe('');
    expect(profile.phone).toBe('');
    expect(profile.howBrainHelps).toBe('');
  });

  it('throws when the user is gone', async () => {
    users.findProfile.mockResolvedValue(null);

    await expect(service().get(USER)).rejects.toBeInstanceOf(UserProfileNotFoundError);
  });
});

describe('UserProfileService.update', () => {
  it('writes only the keys the form sent', async () => {
    await service().update(USER, { nickName: 'Rusy' });

    expect(users.updateProfile).toHaveBeenCalledWith(USER, { nickname: 'Rusy' });
  });

  it('trims every field before storing it', async () => {
    await service().update(USER, { fullName: '  Nur Khairusy  ', jobTitle: ' VP ' });

    expect(users.updateProfile).toHaveBeenCalledWith(USER, {
      name: 'Nur Khairusy',
      job_title: 'VP',
    });
  });

  it('stores a cleared optional field as null, not an empty string', async () => {
    // "Cleared" and "never set" should be one state in the database, not two.
    await service().update(USER, { nickName: '   ', phone: '' });

    expect(users.updateProfile).toHaveBeenCalledWith(USER, { nickname: null, phone: null });
  });

  it('refuses to blank the full name, which the rest of the app renders', async () => {
    await expect(service().update(USER, { fullName: '  ' })).rejects.toBeInstanceOf(
      UserProfileInvalidError,
    );
    expect(users.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects a phone with letters in it', async () => {
    await expect(service().update(USER, { phone: 'call me' })).rejects.toBeInstanceOf(
      UserProfileInvalidError,
    );
  });

  it('accepts the punctuation people actually type in a phone number', async () => {
    await service().update(USER, { phone: '+62 (812) 345-6789'.replace('+62 ', '') });

    expect(users.updateProfile).toHaveBeenCalledWith(USER, { phone: '(812) 345-6789' });
  });

  it('rejects an over-long free-text field', async () => {
    await expect(
      service().update(USER, { howBrainHelps: 'x'.repeat(501) }),
    ).rejects.toBeInstanceOf(UserProfileInvalidError);
  });

  it('never writes the email, which is the sign-in identity', async () => {
    // Cast because the input type has no `email` key at all — this asserts the
    // runtime behaviour matches that, for a caller that bypasses the types.
    await service().update(USER, {
      fullName: 'Nur',
      email: 'other@example.com',
    } as Parameters<UserProfileService['update']>[1]);

    expect(users.updateProfile.mock.calls[0][1]).not.toHaveProperty('email');
  });

  it('skips the UPDATE entirely when the form sent nothing', async () => {
    const result = await service().update(USER, {});

    expect(users.updateProfile).not.toHaveBeenCalled();
    expect(users.findProfile).toHaveBeenCalled();
    expect(result.fullName).toBe('Nur Khairusy');
  });

  it('throws when the user is gone', async () => {
    users.updateProfile.mockResolvedValue(null);

    await expect(service().update(USER, { nickName: 'x' })).rejects.toBeInstanceOf(
      UserProfileNotFoundError,
    );
  });
});
