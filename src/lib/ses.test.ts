import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ses.ts reads AWS creds into module-scope consts at import time, so they must
// be present before the import below runs — set them in a hoisted block.
const { sendMock, captureMock } = vi.hoisted(() => {
  process.env.AWS_ACCESS_KEY_ID = 'test-key';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  return { sendMock: vi.fn(), captureMock: vi.fn() };
});

vi.mock('@aws-sdk/client-sesv2', () => ({
  SESv2Client: class {
    send = sendMock;
  },
  // Mirror the real command: expose the constructor input as `.input`.
  SendEmailCommand: class {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock('@/lib/posthog-server', () => ({
  captureWorkspaceEvent: captureMock,
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn().mockResolvedValue('ws-1'),
}));

import {
  sendEmail,
  sendEmailWithAttachment,
  ALWAYS_CC_EMAIL,
  _resetSesClientForTests,
} from './ses';

interface CapturedCommand {
  input: {
    Destination: { ToAddresses?: string[]; CcAddresses?: string[] };
    Content: { Raw?: { Data: Buffer } };
  };
}

/** Grab the SES command input from the most recent `send` call. */
function lastCommandInput(): CapturedCommand['input'] {
  return (sendMock.mock.calls.at(-1)?.[0] as CapturedCommand).input;
}

describe('sendEmail (CC handling)', () => {
  beforeEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    sendMock.mockReset().mockResolvedValue({ MessageId: 'msg-1' });
    captureMock.mockReset();
    _resetSesClientForTests();
  });

  afterEach(() => vi.clearAllMocks());

  it('captures an email_sent PostHog event on success', async () => {
    await sendEmail({
      to: ['a@b.com', 'c@d.com'],
      subject: 'Hello',
      html: '<p>x</p>',
      text: 'x',
    });

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        distinctId: 'server',
        event: 'email_sent',
        properties: expect.objectContaining({
          recipient_count: 2,
          subject: 'Hello',
          has_attachments: false,
        }),
      }),
    );
  });

  it('always CCs the hardcoded address when no cc is supplied', async () => {
    await sendEmail({ to: 'a@b.com', subject: 's', html: '<p>x</p>', text: 'x' });

    expect(lastCommandInput().Destination.CcAddresses).toEqual([ALWAYS_CC_EMAIL]);
  });

  it('appends the hardcoded address to caller-supplied CCs', async () => {
    await sendEmail({
      to: 'a@b.com',
      cc: ['team@b.com', 'boss@b.com'],
      subject: 's',
      html: '<p>x</p>',
      text: 'x',
    });

    expect(lastCommandInput().Destination.CcAddresses).toEqual([
      'team@b.com',
      'boss@b.com',
      ALWAYS_CC_EMAIL,
    ]);
  });

  it('dedupes the hardcoded address if the caller already CCd it (case-insensitive)', async () => {
    await sendEmail({
      to: 'a@b.com',
      cc: 'Nico.Alimin@SMMA.id',
      subject: 's',
      html: '<p>x</p>',
      text: 'x',
    });

    expect(lastCommandInput().Destination.CcAddresses).toEqual(['Nico.Alimin@SMMA.id']);
  });

  it('omits the hardcoded address from CC when it is already a To recipient', async () => {
    await sendEmail({
      to: [ALWAYS_CC_EMAIL, 'a@b.com'],
      subject: 's',
      html: '<p>x</p>',
      text: 'x',
    });

    expect(lastCommandInput().Destination.CcAddresses).toBeUndefined();
  });
});

describe('sendEmailWithAttachment (CC handling)', () => {
  beforeEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    sendMock.mockReset().mockResolvedValue({ MessageId: 'msg-2' });
    captureMock.mockReset();
    process.env.AWS_ACCESS_KEY_ID = 'test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'test-secret';
    _resetSesClientForTests();
  });

  afterEach(() => vi.clearAllMocks());

  it('captures an email_sent PostHog event with has_attachments true', async () => {
    await sendEmailWithAttachment({
      to: 'a@b.com',
      subject: 's',
      html: '<p>x</p>',
      text: 'x',
      attachments: [
        { filename: 'f.txt', content: Buffer.from('hi'), contentType: 'text/plain' },
      ],
    });

    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'email_sent',
        properties: expect.objectContaining({
          has_attachments: true,
          attachment_count: 1,
        }),
      }),
    );
  });

  it('sets CcAddresses on the destination and a Cc header in the raw MIME', async () => {
    await sendEmailWithAttachment({
      to: 'a@b.com',
      subject: 's',
      html: '<p>x</p>',
      text: 'x',
      attachments: [
        { filename: 'f.txt', content: Buffer.from('hi'), contentType: 'text/plain' },
      ],
    });

    const input = lastCommandInput();
    expect(input.Destination.CcAddresses).toEqual([ALWAYS_CC_EMAIL]);

    const raw = (input.Content.Raw.Data as Buffer).toString('utf-8');
    expect(raw).toContain(`Cc: ${ALWAYS_CC_EMAIL}`);
  });
});
