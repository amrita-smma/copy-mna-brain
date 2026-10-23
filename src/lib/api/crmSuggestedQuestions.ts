import { apiRequest } from '@/lib/api/client';
import type {
  SuggestedQuestion,
  SuggestedQuestionsResult,
} from '@/lib/services/crmSuggestedQuestionService';

export type { SuggestedQuestion, SuggestedQuestionsResult };

/** The signed-in user's "Ask Brain" questions for today (CRM page row). */
export function getSuggestedQuestions(): Promise<SuggestedQuestionsResult> {
  return apiRequest<SuggestedQuestionsResult>('/api/crm/suggested-questions');
}
