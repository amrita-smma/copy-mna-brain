import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ runBotMessageStep: vi.fn() }));

vi.mock('./botMessageStep', () => ({ runBotMessageStep: m.runBotMessageStep }));

import { botMessageWorkflow, type BotMessageRunInput } from './botMessageWorkflow';

const input: BotMessageRunInput = {
  jobId: 'job-1',
  workspaceId: 'ws-9',
  userId: 'u1',
  origin: { kind: 'bot_reply', replies: [] },
  toBotId: 'copilot',
  text: 'Reply from Deal Scout: …',
};

describe('botMessageWorkflow', () => {
  beforeEach(() => {
    m.runBotMessageStep.mockReset();
    m.runBotMessageStep.mockResolvedValue({ ran: true });
  });

  it('runs the one step with the message and nothing else', async () => {
    await botMessageWorkflow(input);
    expect(m.runBotMessageStep).toHaveBeenCalledTimes(1);
    expect(m.runBotMessageStep).toHaveBeenCalledWith(input);
  });

  it('fails the run when the step fails, so WDK records it', async () => {
    m.runBotMessageStep.mockRejectedValueOnce(new Error('step died'));
    await expect(botMessageWorkflow(input)).rejects.toThrow('step died');
  });
});
