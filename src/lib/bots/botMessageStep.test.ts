import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({
  db: { tag: 'step-db' },
  claimPending: vi.fn(),
  failIfRunning: vi.fn(),
  findById: vi.fn(),
  runJob: vi.fn(),
  runBotMessage: vi.fn(),
  close: vi.fn(),
  createContainer: vi.fn(),
  getStepMetadata: vi.fn(),
  workspacesSeen: [] as string[],
}));

vi.mock('workflow', () => ({ getStepMetadata: m.getStepMetadata }));
vi.mock('@/lib/server/db', () => ({ createDb: () => m.db }));
vi.mock('@/lib/repositories', () => ({
  JobRepository: class {
    constructor(public readonly db: unknown) {}
    claimPending = m.claimPending;
    failIfRunning = m.failIfRunning;
    findById = m.findById;
  },
}));
vi.mock('@/lib/jobs/runner', () => ({ runJob: m.runJob }));
vi.mock('@/lib/jobs/handlers/botMessage', () => ({
  BOT_MESSAGE_TIMEOUT_SECONDS: 600,
  runBotMessage: m.runBotMessage,
}));
vi.mock('@/lib/services/container', () => ({ createContainer: m.createContainer }));
vi.mock('@/lib/workspace', () => ({
  runWithWorkforceWorkspaceId: async (workspaceId: string, fn: () => Promise<unknown>) => {
    m.workspacesSeen.push(workspaceId);
    return fn();
  },
}));

import { CUT_OFF_NOTE, runBotMessageStep, type BotMessageRunInput } from './botMessageStep';

const input: BotMessageRunInput = {
  jobId: 'job-1',
  workspaceId: 'ws-9',
  userId: 'u1',
  origin: { kind: 'bot_mention', fromBot: { id: 'copilot', name: 'Copilot' } },
  toBotId: 'scout',
  text: 'Find targets',
  requestId: 'req-1',
};

describe('runBotMessageStep', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    m.workspacesSeen.length = 0;
    m.getStepMetadata.mockReturnValue({ attempt: 1 });
    m.createContainer.mockReturnValue({ botRequestService: { close: m.close } });
    m.close.mockResolvedValue({ closed: true, repliedTo: null });
    m.failIfRunning.mockResolvedValue({ id: 'job-1', status: 'failed' });
    m.findById.mockResolvedValue({ id: 'job-1', status: 'completed', error: null });
    m.runBotMessage.mockResolvedValue({ chatId: 'chat-1' });
    // The runner invokes the work it is given, as the real one does.
    m.runJob.mockImplementation(async (_repo, _id, _timeout, work: () => Promise<unknown>) => {
      await work();
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('claims the pending job and runs the turn through the job runner with the job budget', async () => {
    m.claimPending.mockResolvedValue({ id: 'job-1', status: 'running' });

    const out = await runBotMessageStep(input);

    expect(out).toEqual({ ran: true });
    expect(m.claimPending).toHaveBeenCalledWith('job-1');
    const [repo, jobId, timeoutMs] = m.runJob.mock.calls[0];
    expect(repo.db).toBe(m.db);
    expect(jobId).toBe('job-1');
    expect(timeoutMs).toBe(600_000);
    expect(m.runBotMessage).toHaveBeenCalledWith({
      db: m.db,
      workspaceId: 'ws-9',
      userId: 'u1',
      origin: input.origin,
      toBotId: 'scout',
      text: 'Find targets',
      requestId: 'req-1',
    });
    expect(m.failIfRunning).not.toHaveBeenCalled();
  });

  it('leaves a job it cannot claim alone on the first delivery: the live attempt owns it', async () => {
    m.claimPending.mockResolvedValue(null);
    m.getStepMetadata.mockReturnValue({ attempt: 1 });

    const out = await runBotMessageStep(input);

    expect(out).toEqual({ ran: false });
    expect(m.runJob).not.toHaveBeenCalled();
    expect(m.failIfRunning).not.toHaveBeenCalled();
    expect(m.close).not.toHaveBeenCalled();
  });

  it('treats a missing attempt count as the first delivery', async () => {
    m.claimPending.mockResolvedValue(null);
    m.getStepMetadata.mockImplementation(() => {
      throw new Error('not in a step');
    });

    await expect(runBotMessageStep(input)).resolves.toEqual({ ran: false });
    expect(m.failIfRunning).not.toHaveBeenCalled();
  });

  it('on a retry, fails a job the previous attempt left running and closes its request instead of re-running the turn', async () => {
    m.claimPending.mockResolvedValue(null);
    m.getStepMetadata.mockReturnValue({ attempt: 2 });

    const out = await runBotMessageStep(input);

    expect(out).toEqual({ ran: false });
    expect(m.runJob).not.toHaveBeenCalled();
    expect(m.runBotMessage).not.toHaveBeenCalled();
    expect(m.failIfRunning).toHaveBeenCalledWith('job-1', CUT_OFF_NOTE);
    expect(m.createContainer).toHaveBeenCalledWith(m.db, 'ws-9');
    expect(m.workspacesSeen).toEqual(['ws-9']);
    expect(m.close).toHaveBeenCalledWith('req-1', { failure: CUT_OFF_NOTE });
  });

  it('on a retry, closes no request for a cut-off turn that was not answering one', async () => {
    m.claimPending.mockResolvedValue(null);
    m.getStepMetadata.mockReturnValue({ attempt: 2 });

    const { requestId: _omit, ...noRequest } = input;
    await runBotMessageStep(noRequest);

    expect(m.failIfRunning).toHaveBeenCalledWith('job-1', CUT_OFF_NOTE);
    expect(m.createContainer).not.toHaveBeenCalled();
    expect(m.close).not.toHaveBeenCalled();
  });

  it('on a retry, touches nothing when the previous attempt finished after all', async () => {
    m.claimPending.mockResolvedValue(null);
    m.getStepMetadata.mockReturnValue({ attempt: 2 });
    m.failIfRunning.mockResolvedValue(null);

    const out = await runBotMessageStep(input);

    expect(out).toEqual({ ran: false });
    expect(m.runJob).not.toHaveBeenCalled();
    expect(m.close).not.toHaveBeenCalled();
  });

  it('still returns when failing the job or closing the request throws', async () => {
    m.claimPending.mockResolvedValue(null);
    m.getStepMetadata.mockReturnValue({ attempt: 2 });
    m.failIfRunning.mockRejectedValueOnce(new Error('db gone'));

    await expect(runBotMessageStep(input)).resolves.toEqual({ ran: false });
    expect(m.close).not.toHaveBeenCalled();

    m.failIfRunning.mockResolvedValueOnce({ id: 'job-1', status: 'failed' });
    m.close.mockRejectedValueOnce(new Error('lock gone'));
    await expect(runBotMessageStep(input)).resolves.toEqual({ ran: false });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('allows one retry, so a killed step is retried once and then fails cleanly', () => {
    expect(runBotMessageStep.maxRetries).toBe(1);
  });
});
