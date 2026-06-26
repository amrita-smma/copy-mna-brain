import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findAll, sendAgentEmail } = vi.hoisted(() => ({
  findAll: vi.fn(),
  sendAgentEmail: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));

vi.mock('@/lib/repositories', () => ({
  UserRepository: class {
    findAll = findAll;
  },
}));

vi.mock('@/lib/services/emailService', () => ({
  EmailService: class {
    sendAgentEmail = sendAgentEmail;
  },
}));

import { sendEmailTool } from './send_email';

function invoke(args: Record<string, unknown>) {
  return sendEmailTool.invoke(args);
}

const PLATFORM_USERS = [
  { id: 'u1', name: 'Ana', email: 'ana@e.com', role: null },
  { id: 'u2', name: 'Bo', email: 'BO@e.com', role: null },
  { id: 'u3', name: 'No Email', email: null, role: null },
];

describe('send_email', () => {
  beforeEach(() => {
    findAll.mockReset();
    sendAgentEmail.mockReset();
    findAll.mockResolvedValue(PLATFORM_USERS);
    sendAgentEmail.mockResolvedValue({ messageId: 'msg-1' });
  });

  it('requires a non-blank subject and body (whitespace is trimmed)', async () => {
    expect(String(await invoke({ to: ['ana@e.com'], subject: '   ', body: 'hi' }))).toMatch(
      /subject is required/i,
    );
    expect(String(await invoke({ to: ['ana@e.com'], subject: 's', body: '   ' }))).toMatch(
      /body is required/i,
    );
    expect(sendAgentEmail).not.toHaveBeenCalled();
  });

  it('rejects malformed addresses without sending', async () => {
    const result = await invoke({ to: ['not-an-email'], subject: 's', body: 'b' });
    expect(String(result)).toMatch(/malformed/i);
    expect(sendAgentEmail).not.toHaveBeenCalled();
  });

  it('sends only to whitelisted platform users (case-insensitive match)', async () => {
    const result = await invoke({
      to: ['ana@e.com', 'bo@e.com'],
      subject: 'Hello team',
      body: 'Heads up on the deal.',
    });
    expect(sendAgentEmail).toHaveBeenCalledTimes(2);
    expect(sendAgentEmail).toHaveBeenCalledWith({
      email: 'ana@e.com',
      subject: 'Hello team',
      body: 'Heads up on the deal.',
    });
    // Matched against the stored address ("BO@e.com"), not the lowercased input.
    expect(sendAgentEmail).toHaveBeenCalledWith({
      email: 'BO@e.com',
      subject: 'Hello team',
      body: 'Heads up on the deal.',
    });
    expect(String(result)).toMatch(/Sent to 2 platform user/i);
  });

  it('skips addresses that are not registered platform users', async () => {
    const result = await invoke({
      to: ['ana@e.com', 'stranger@external.com'],
      subject: 's',
      body: 'b',
    });
    expect(sendAgentEmail).toHaveBeenCalledTimes(1);
    expect(sendAgentEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ana@e.com' }),
    );
    expect(String(result)).toMatch(/Sent to 1 platform user/i);
    expect(String(result)).toMatch(/stranger@external\.com/);
  });

  it('errors (sends nothing) when no recipient is on the platform', async () => {
    const result = await invoke({
      to: ['stranger@external.com'],
      subject: 's',
      body: 'b',
    });
    expect(sendAgentEmail).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/^\*\*Error:\*\*/);
    expect(String(result)).toMatch(/registered platform users/i);
  });

  it('de-duplicates repeated recipients', async () => {
    await invoke({
      to: ['ana@e.com', 'ANA@e.com', 'ana@e.com'],
      subject: 's',
      body: 'b',
    });
    expect(sendAgentEmail).toHaveBeenCalledTimes(1);
  });

  it('reports per-recipient send failures without throwing', async () => {
    sendAgentEmail.mockRejectedValueOnce(new Error('SES down'));
    const result = await invoke({
      to: ['ana@e.com', 'bo@e.com'],
      subject: 's',
      body: 'b',
    });
    expect(String(result)).toMatch(/Sent to 1 platform user/i);
    expect(String(result)).toMatch(/Failed to send to: ana@e.com/);
  });
});
