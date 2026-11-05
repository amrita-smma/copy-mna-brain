import { describe, expect, it, vi } from 'vitest';
import { enqueueSendEmail, TOPICS } from './queue';

vi.mock('../../launchpad/queue', () => ({
  send: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
}));

describe('enqueueSendEmail', () => {
  it('publishes to the send-email topic with the given payload', async () => {
    const result = await enqueueSendEmail({
      kind: 'forgot_password',
      to: 'user@example.com',
      token: 'tok-1',
      appUrl: 'https://app.example.com',
    });

    const { send } = await import('../../launchpad/queue');
    expect(send).toHaveBeenCalledWith('send-email', {
      kind: 'forgot_password',
      to: 'user@example.com',
      token: 'tok-1',
      appUrl: 'https://app.example.com',
    });
    expect(result).toEqual({ messageId: 'msg-1' });
  });

  it('exposes the topic constant matching vercel.json', () => {
    expect(TOPICS.sendEmail).toBe('send-email');
  });
});
