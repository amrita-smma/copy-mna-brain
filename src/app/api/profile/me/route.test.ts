import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  createContainer: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mocks.getActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));

import { GET, PATCH } from './route';
import {
  UserProfileInvalidError,
  UserProfileNotFoundError,
} from '@/lib/services/userProfileService';

const profile = {
  id: 'user-1',
  fullName: 'Nur Khairusy',
  nickName: 'Nur',
  email: 'nur@example.com',
  phoneCode: '+62',
  phone: '8123456789',
  jobTitle: 'Investment Associate',
  howBrainHelps: 'Screens inbound deals.',
};

const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/profile/me', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.getActiveWorkspaceId.mockResolvedValue('ws-1');
  mocks.get.mockResolvedValue(profile);
  mocks.update.mockResolvedValue(profile);
  mocks.createContainer.mockReturnValue({
    userProfileService: { get: mocks.get, update: mocks.update },
  });
});

describe('GET /api/profile/me', () => {
  it('serves the session user’s own profile', async () => {
    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: profile });
    expect(mocks.get).toHaveBeenCalledWith('user-1');
  });

  it('401s without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    expect((await GET()).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('404s when the account is gone', async () => {
    mocks.get.mockRejectedValue(new UserProfileNotFoundError());

    expect((await GET()).status).toBe(404);
  });
});

describe('PATCH /api/profile/me', () => {
  it('writes the editable fields for the session user', async () => {
    const res = await PATCH(patch({ fullName: 'Nur K', jobTitle: 'VP' }));

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ fullName: 'Nur K', jobTitle: 'VP' }),
    );
  });

  it('takes the user from the session, never from the body', async () => {
    await PATCH(patch({ fullName: 'Nur', userId: 'someone-else' }));

    expect(mocks.update.mock.calls[0][0]).toBe('user-1');
  });

  it('never forwards an email, which is the sign-in identity', async () => {
    // Changing one is an admin operation; this form must not be a way around it.
    await PATCH(patch({ fullName: 'Nur', email: 'attacker@example.com' }));

    expect(mocks.update.mock.calls[0][1]).not.toHaveProperty('email');
  });

  it('400s with the message when the input is rejected', async () => {
    mocks.update.mockRejectedValue(new UserProfileInvalidError('Full name is required'));

    const res = await PATCH(patch({ fullName: '  ' }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Full name is required' });
  });

  it('401s without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    expect((await PATCH(patch({ fullName: 'Nur' }))).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('500s on an unexpected failure', async () => {
    mocks.update.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await PATCH(patch({ fullName: 'Nur' }))).status).toBe(500);

    spy.mockRestore();
  });
});
