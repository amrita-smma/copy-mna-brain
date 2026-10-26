import type {
  CopilotChatsRepository,
  CopilotMessageRepository,
  CopilotMessageRow,
  CopilotResponseFeedbackRepository,
  CopilotResponseFeedbackRow,
} from '@/lib/repositories';
import { parseResponseFeedback } from '@/lib/chat/responseFeedback';
import { sendLangfuseScore, type LangfuseScoreInput } from '@/lib/langfuseScore';
import { CopilotChatForbiddenError, CopilotChatNotFoundError } from './copilotChatsService';

/** The Langfuse score a vote is recorded under, on the turn's trace. */
export const RESPONSE_FEEDBACK_SCORE_NAME = 'user_feedback';

/** The body did not describe a valid vote (bad rating, unknown reason, …). */
export class InvalidResponseFeedbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidResponseFeedbackError';
  }
}

/** The vote names no question row in this chat, so there is no turn to rate. */
export class ResponseFeedbackTurnNotFoundError extends Error {
  constructor(messageId: string) {
    super(`No turn ${messageId} in this chat`);
    this.name = 'ResponseFeedbackTurnNotFoundError';
  }
}

export interface SubmitResponseFeedbackInput {
  userId: string;
  chatId: string;
  /** The turn's question row (copilot_messages, role 'user'). */
  messageId: string;
  rating?: unknown;
  reasons?: unknown;
  comment?: unknown;
}

export interface CopilotResponseFeedbackDeps {
  feedback: CopilotResponseFeedbackRepository;
  messages: CopilotMessageRepository;
  chats: CopilotChatsRepository;
  /** Injectable for tests; defaults to the real Langfuse client. */
  sendScore?: (score: LangfuseScoreInput) => Promise<void>;
}

/**
 * The Langfuse trace a turn ran under. The chat route runs a turn with its
 * question row's id as the root `runId` — which the Langfuse handler takes as
 * the trace id — in the same change that stamps `model` on that row, so a row
 * with a model has a trace of its own id. Older and background turns have
 * neither, and no trace to link.
 */
export function turnTraceId(question: Pick<CopilotMessageRow, 'id' | 'model'>): string | null {
  return question.model ? question.id : null;
}

/**
 * Feedback on Copilot replies (MB-693): one vote per user per turn — thumbs
 * up/down, the reasons behind a thumbs-down, and an optional comment — stored
 * against the turn's question row and copied to the turn's Langfuse trace as a
 * score.
 */
export class CopilotResponseFeedbackService {
  private readonly sendScore: (score: LangfuseScoreInput) => Promise<void>;

  constructor(private readonly deps: CopilotResponseFeedbackDeps) {
    this.sendScore = deps.sendScore ?? sendLangfuseScore;
  }

  /**
   * Record the user's vote on a turn of their own chat, replacing any earlier
   * one. The bot, model and effort tier are read from the question row, never
   * from the caller.
   */
  async submit(input: SubmitResponseFeedbackInput): Promise<CopilotResponseFeedbackRow> {
    const parsed = parseResponseFeedback(input);
    if ('error' in parsed) throw new InvalidResponseFeedbackError(parsed.error);

    const chat = await this.deps.chats.getById(input.chatId);
    if (!chat) throw new CopilotChatNotFoundError(input.chatId);
    if (chat.user_id !== input.userId) throw new CopilotChatForbiddenError(input.chatId);

    const question = await this.deps.messages.findById(input.messageId);
    if (!question || question.chat_id !== chat.id || question.role !== 'user') {
      throw new ResponseFeedbackTurnNotFoundError(input.messageId);
    }

    return this.deps.feedback.upsert({
      userId: input.userId,
      chatId: chat.id,
      messageId: question.id,
      botId: question.bot_id,
      traceId: turnTraceId(question),
      model: question.model,
      effortTier: question.effort_tier,
      rating: parsed.value.rating,
      reasons: parsed.value.reasons,
      comment: parsed.value.comment,
    });
  }

  /**
   * Copy a stored vote onto its turn's trace. The score's id is the row's, so
   * a changed vote replaces the score instead of adding a second one. A turn
   * with no trace, or a comment with no rating, has nothing to score.
   */
  async scoreInLangfuse(row: CopilotResponseFeedbackRow): Promise<void> {
    if (!row.trace_id || row.rating === null) return;
    await this.sendScore({
      id: row.id,
      traceId: row.trace_id,
      name: RESPONSE_FEEDBACK_SCORE_NAME,
      value: row.rating,
      comment: row.comment,
      metadata: {
        reasons: row.reasons,
        chat_id: row.chat_id,
        bot_id: row.bot_id,
        model: row.model,
        effort_tier: row.effort_tier,
      },
    });
  }
}
