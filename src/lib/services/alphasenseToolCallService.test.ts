import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlphasenseToolCallService } from './alphasenseToolCallService';
import type { AlphasenseToolCallRepository } from '@/lib/repositories';

describe('AlphasenseToolCallService.recordCall', () => {
  let repo: { create: ReturnType<typeof vi.fn> };
  let service: AlphasenseToolCallService;

  beforeEach(() => {
    repo = { create: vi.fn() };
    service = new AlphasenseToolCallService(repo as unknown as AlphasenseToolCallRepository);
  });

  it('normalizes undefined optional fields to null before writing', async () => {
    repo.create.mockResolvedValueOnce({ id: 'call-1' });

    await service.recordCall({ prompt: 'Apple Q4?', status: 'success' });

    expect(repo.create).toHaveBeenCalledWith({
      chat_thread_id: null,
      original_question: null,
      prompt: 'Apple Q4?',
      conversation_id: null,
      status: 'success',
      response_markdown: null,
      error_message: null,
    });
  });

  it('passes through every field when supplied', async () => {
    repo.create.mockResolvedValueOnce({ id: 'call-1' });

    await service.recordCall({
      chatThreadId: 'thread-1',
      originalQuestion: 'What were Apple Q4 results?',
      prompt: 'Apple Q4 2024 revenue and EBITDA?',
      conversationId: 'conv-1',
      status: 'timed_out',
      responseMarkdown: 'partial answer',
      errorMessage: null,
    });

    expect(repo.create).toHaveBeenCalledWith({
      chat_thread_id: 'thread-1',
      original_question: 'What were Apple Q4 results?',
      prompt: 'Apple Q4 2024 revenue and EBITDA?',
      conversation_id: 'conv-1',
      status: 'timed_out',
      response_markdown: 'partial answer',
      error_message: null,
    });
  });
});

describe('AlphasenseToolCallService lookback reads', () => {
  let repo: { listByChatThreadId: ReturnType<typeof vi.fn>; listRecent: ReturnType<typeof vi.fn> };
  let service: AlphasenseToolCallService;

  beforeEach(() => {
    repo = { listByChatThreadId: vi.fn(), listRecent: vi.fn() };
    service = new AlphasenseToolCallService(repo as unknown as AlphasenseToolCallRepository);
  });

  it('listByChatThreadId delegates straight to the repository', async () => {
    repo.listByChatThreadId.mockResolvedValueOnce([{ id: 'call-1' }]);

    const result = await service.listByChatThreadId('thread-1', { limit: 5 });

    expect(result).toEqual([{ id: 'call-1' }]);
    expect(repo.listByChatThreadId).toHaveBeenCalledWith('thread-1', { limit: 5 });
  });

  it('listRecent delegates straight to the repository', async () => {
    repo.listRecent.mockResolvedValueOnce([{ id: 'call-2' }]);

    const result = await service.listRecent({ limit: 20 });

    expect(result).toEqual([{ id: 'call-2' }]);
    expect(repo.listRecent).toHaveBeenCalledWith({ limit: 20 });
  });
});
