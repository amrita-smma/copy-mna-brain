import { describe, expect, it, vi } from 'vitest';

// Mock @vercel/queue so importing the route module doesn't try to talk to
// Vercel's queue API at module load. We capture the options that
// handleCallback receives so we can assert the consumer was wired correctly.
const handleCallbackMock = vi.fn((handler: unknown, options: unknown) => ({
  handler,
  options,
}));

vi.mock('../../../../../launchpad/queue', () => ({
  handleCallback: handleCallbackMock,
}));

vi.mock('@/lib/jobs/handlers/sendEmail', () => ({
  SEND_EMAIL_TIMEOUT_SECONDS: 30,
  runSendEmail: vi.fn().mockResolvedValue({
    kind: 'forgot_password',
    to: 'user@example.com',
    messageId: 'ses-1',
  }),
}));

describe('POST /api/queues/send-email', () => {
  it('registers the queue handler with the expected visibility timeout', async () => {
    await import('./route');

    expect(handleCallbackMock).toHaveBeenCalledTimes(1);
    const options = handleCallbackMock.mock.calls[0][1] as {
      visibilityTimeoutSeconds?: number;
      retry?: unknown;
    };
    expect(options.visibilityTimeoutSeconds).toBe(30);
    expect(typeof options.retry).toBe('function');
  });

  it('delegates incoming messages to runSendEmail', async () => {
    const { runSendEmail } = await import('@/lib/jobs/handlers/sendEmail');
    await import('./route');

    const handler = handleCallbackMock.mock.calls[0][0] as (
      msg: unknown,
      meta: unknown,
    ) => Promise<void>;

    const message = {
      kind: 'forgot_password',
      to: 'a@b.com',
      token: 't',
      appUrl: 'https://x.com',
    };
    await handler(message, { messageId: 'm1', deliveryCount: 1 });

    expect(runSendEmail).toHaveBeenCalledWith(message);
  });

  it('caps retries at 5 deliveries and acknowledges after that', async () => {
    await import('./route');
    const options = handleCallbackMock.mock.calls[0][1] as {
      retry: (err: Error, meta: { deliveryCount: number }) => unknown;
    };

    expect(options.retry(new Error('x'), { deliveryCount: 6 })).toEqual({
      acknowledge: true,
    });
    const ret = options.retry(new Error('x'), { deliveryCount: 2 }) as {
      afterSeconds: number;
    };
    expect(ret.afterSeconds).toBeGreaterThan(0);
    expect(ret.afterSeconds).toBeLessThanOrEqual(300);
  });
});
