import { apiRequest } from '@/lib/api/client';
import type { ResponseFeedbackValue } from '@/lib/chat/responseFeedback';

/**
 * Save the caller's feedback on one reply, replacing any they left before.
 * `questionId` is the reply's `metadata.questionId`. Resolves to the stored vote.
 */
export function saveResponseFeedback(
  chatId: string,
  questionId: string,
  value: ResponseFeedbackValue,
): Promise<ResponseFeedbackValue> {
  return apiRequest<ResponseFeedbackValue>(
    `/api/copilot/chats/${encodeURIComponent(chatId)}/feedback`,
    {
      method: 'PUT',
      body: JSON.stringify({ messageId: questionId, ...value }),
    },
  );
}
