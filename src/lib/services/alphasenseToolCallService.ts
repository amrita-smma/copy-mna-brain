import type {
  AlphasenseToolCallRepository,
  AlphasenseToolCallRow,
  ListAlphasenseToolCallsOptions,
} from '@/lib/repositories';

export type AlphasenseToolCallStatus = 'success' | 'timed_out' | 'error' | 'not_configured';

export interface RecordAlphasenseToolCallInput {
  chatThreadId?: string | null;
  originalQuestion?: string | null;
  prompt: string;
  conversationId?: string | null;
  status: AlphasenseToolCallStatus;
  responseMarkdown?: string | null;
  errorMessage?: string | null;
}

export class AlphasenseToolCallService {
  constructor(private readonly repo: AlphasenseToolCallRepository) {}

  recordCall(input: RecordAlphasenseToolCallInput): Promise<AlphasenseToolCallRow> {
    return this.repo.create({
      chat_thread_id: input.chatThreadId ?? null,
      original_question: input.originalQuestion ?? null,
      prompt: input.prompt,
      conversation_id: input.conversationId ?? null,
      status: input.status,
      response_markdown: input.responseMarkdown ?? null,
      error_message: input.errorMessage ?? null,
    });
  }

  /** Every AlphaSense call made within a single chat thread, for historical lookback. */
  listByChatThreadId(
    chatThreadId: string,
    options?: ListAlphasenseToolCallsOptions,
  ): Promise<AlphasenseToolCallRow[]> {
    return this.repo.listByChatThreadId(chatThreadId, options);
  }

  /** Recent AlphaSense calls across the workspace, for historical lookback. */
  listRecent(options?: ListAlphasenseToolCallsOptions): Promise<AlphasenseToolCallRow[]> {
    return this.repo.listRecent(options);
  }
}
