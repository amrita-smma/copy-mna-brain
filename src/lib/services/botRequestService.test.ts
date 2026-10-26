import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BOT_REQUEST_ASK_MAX_LENGTH,
  BOT_REQUEST_TIMEOUT_SECONDS,
  BotRequestService,
  TIMED_OUT_NOTE,
  formatReplies,
} from './botRequestService';
import type { BotRequestRepository, BotRequestRow } from '@/lib/repositories';

const repo = {
  createMany: vi.fn<BotRequestRepository['createMany']>(),
  close: vi.fn<BotRequestRepository['close']>(),
  findStale: vi.fn<BotRequestRepository['findStale']>(),
};
const dispatchBotMessage = vi.fn();

const request = (over: Partial<BotRequestRow> = {}): BotRequestRow => ({
  id: 'r1',
  workspace_id: 'ws-1',
  group_id: 'g1',
  user_id: 'u1',
  from_bot_id: 'a',
  from_bot_name: 'Atlas',
  from_chat_id: 'chat-a',
  to_bot_id: 'b',
  to_bot_name: 'Scout',
  ask: 'Find targets',
  answer: null,
  status: 'pending',
  created_at: '2026-10-19T00:00:00Z',
  closed_at: null,
  ...over,
});

describe('BotRequestService', () => {
  let service: BotRequestService;

  beforeEach(() => {
    for (const fn of [...Object.values(repo), dispatchBotMessage]) fn.mockReset();
    dispatchBotMessage.mockResolvedValue(undefined);
    service = new BotRequestService({
      workspaceId: 'ws-1',
      repo: repo as unknown as BotRequestRepository,
      dispatchBotMessage,
    });
  });

  describe('BotRequestService.open', () => {
    it('writes one row per target with the clipped ask', async () => {
      repo.createMany.mockImplementation(async (rows) => rows.map((r, i) => request({ ...r, id: `r${i}` })));

      const rows = await service.open({
        userId: 'u1',
        fromBot: { id: 'a', name: 'Atlas' },
        fromChatId: 'chat-a',
        groupId: 'g1',
        targets: [
          { id: 'b', name: 'Scout' },
          { id: 'c', name: 'Miner' },
        ],
        ask: 'x'.repeat(BOT_REQUEST_ASK_MAX_LENGTH + 50),
      });

      expect(repo.createMany.mock.calls[0][0]).toHaveLength(2);
      expect(repo.createMany.mock.calls[0][0][1]).toMatchObject({ group_id: 'g1', to_bot_id: 'c', to_bot_name: 'Miner' });
      expect(repo.createMany.mock.calls[0][0][0].ask).toHaveLength(BOT_REQUEST_ASK_MAX_LENGTH);
      expect(rows.map((r) => r.id)).toEqual(['r0', 'r1']);
    });
  });

  describe('BotRequestService.close', () => {
    it('closes with the answer and sends nothing while siblings are open', async () => {
      repo.close.mockResolvedValue({ closed: request({ status: 'done' }), group: null });

      const result = await service.close('r1', { answer: 'NAV is 1.2x.' });

      expect(repo.close).toHaveBeenCalledWith('r1', { status: 'done', answer: 'NAV is 1.2x.' });
      expect(dispatchBotMessage).not.toHaveBeenCalled();
      expect(result).toEqual({ closed: true, repliedTo: null });
    });

    it('fans the whole group into one bot_reply turn for the asker when it closes the last request', async () => {
      const group = [
        request({ id: 'r0', to_bot_id: 'c', to_bot_name: 'Miner', ask: 'Coal comps?', status: 'failed', answer: 'anthropic 529' }),
        request({ id: 'r1', status: 'done', answer: 'NAV is 1.2x.' }),
        request({ id: 'r2', to_bot_id: 'd', to_bot_name: 'Echo', status: 'timed_out', answer: TIMED_OUT_NOTE }),
      ];
      repo.close.mockResolvedValue({ closed: group[1], group });

      const result = await service.close('r1', { answer: 'NAV is 1.2x.' });

      expect(dispatchBotMessage).toHaveBeenCalledTimes(1);
      const job = dispatchBotMessage.mock.calls[0][0];
      expect(job).toMatchObject({ userId: 'u1', toBotId: 'a' });
      expect(job.origin).toEqual({
        kind: 'bot_reply',
        replies: [
          { fromBot: { id: 'c', name: 'Miner' }, requestId: 'r0', ask: 'Coal comps?', answer: null, failure: 'anthropic 529' },
          { fromBot: { id: 'b', name: 'Scout' }, requestId: 'r1', ask: 'Find targets', answer: 'NAV is 1.2x.', failure: null },
          { fromBot: { id: 'd', name: 'Echo' }, requestId: 'r2', ask: 'Find targets', answer: null, failure: TIMED_OUT_NOTE },
        ],
      });
      expect(job.text).toContain('**Scout** — you asked: «Find targets»');
      expect(job.text).toContain('NAV is 1.2x.');
      expect(job.text).toContain('Could not complete it: anthropic 529.');
      expect(result).toEqual({ closed: true, repliedTo: 'a' });
    });

    it('records a failure with its note', async () => {
      repo.close.mockResolvedValue({ closed: request({ status: 'failed' }), group: null });
      await service.close('r1', { failure: 'anthropic 529' });
      expect(repo.close).toHaveBeenCalledWith('r1', { status: 'failed', answer: 'anthropic 529' });
    });

    it('keeps the whole answer, however long — bots hand each other research reports', async () => {
      repo.close.mockResolvedValue({ closed: request({ status: 'done' }), group: null });
      const report = `# Report\n\n${'Findings. '.repeat(5_000).trimEnd()}`;
      await service.close('r1', { answer: `  ${report}\n` });
      expect(repo.close).toHaveBeenCalledWith('r1', { status: 'done', answer: report });
    });

    it('does nothing more for a request already closed', async () => {
      repo.close.mockResolvedValue({ closed: null, group: null });

      await expect(service.close('r1', { answer: 'late' })).resolves.toEqual({ closed: false, repliedTo: null });

      expect(dispatchBotMessage).not.toHaveBeenCalled();
    });
  });

  describe('BotRequestService.sweep', () => {
    it('times out every stale request, counting the ones it closed, and goes on past a failure', async () => {
      repo.findStale.mockResolvedValue([request({ id: 'r1' }), request({ id: 'r2' }), request({ id: 'r3' })]);
      repo.close
        .mockResolvedValueOnce({ closed: request({ id: 'r1', status: 'timed_out' }), group: null })
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({ closed: null, group: null });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(service.sweep()).resolves.toBe(1);

      expect(repo.findStale).toHaveBeenCalledWith(BOT_REQUEST_TIMEOUT_SECONDS, expect.any(Number));
      expect(repo.close).toHaveBeenCalledWith('r1', { status: 'timed_out', answer: TIMED_OUT_NOTE });
      expect(error).toHaveBeenCalledTimes(1);
      error.mockRestore();
    });
  });
});

describe('formatReplies', () => {
  it('lists each answer under who gave it and what was asked', () => {
    const text = formatReplies([
      { fromBot: { id: 'b', name: 'Scout' }, requestId: 'r1', ask: 'Find targets', answer: 'Three found.', failure: null },
      { fromBot: { id: 'c', name: 'Miner' }, requestId: 'r2', ask: 'Comps?', answer: null, failure: TIMED_OUT_NOTE },
    ]);
    expect(text).toBe(
      '**Scout** — you asked: «Find targets»\n\nThree found.\n\n---\n\n**Miner** — you asked: «Comps?»\n\nCould not complete it: did not answer in time.',
    );
  });
});
