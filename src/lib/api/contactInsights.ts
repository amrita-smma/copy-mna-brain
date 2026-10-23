import { apiRequest } from '@/lib/api/client';
import type {
  ContactInsights,
  ContactInteractionSummary,
  ContactRelatedCompany,
  ContactTeamInteraction,
} from '@/lib/services/contactInsightsService';
import type { BankerScorecard, BankerStageCount } from '@/lib/services/bankerScorecardService';
import type { InsightsPeriod } from '@/lib/crm/insightsPeriod';

export type {
  BankerScorecard,
  BankerStageCount,
  ContactInsights,
  ContactInteractionSummary,
  ContactRelatedCompany,
  ContactTeamInteraction,
  InsightsPeriod,
};

/**
 * One CRM contact's insights: per team member emails, last contact, the
 * person's related companies, deal links and deal scorecard.
 */
export function getContactInsights(
  correspondentId: string,
  opts?: { period?: InsightsPeriod },
): Promise<ContactInsights> {
  const params = new URLSearchParams();
  if (opts?.period && opts.period !== 'all') {
    params.set('period', opts.period);
  }
  const qs = params.toString();
  return apiRequest<ContactInsights>(
    `/api/crm/correspondents/${encodeURIComponent(correspondentId)}/insights${qs ? `?${qs}` : ''}`,
  );
}
