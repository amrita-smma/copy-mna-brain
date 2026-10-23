import { apiRequest } from '@/lib/api/client';
import type {
  ContactConversation,
  ContactRoleInference,
  ContactRoleSummary,
  ConversationNote,
  ConversationNoteMember,
  OverviewDealNote,
  RelationshipOverview,
  RelationshipOverviewStatus,
  RoleConfidence,
  RoleLabel,
} from '@/lib/services/contactConversationService';

export type {
  ContactConversation,
  ContactRoleInference,
  ContactRoleSummary,
  ConversationNote,
  ConversationNoteMember,
  OverviewDealNote,
  RelationshipOverview,
  RelationshipOverviewStatus,
  RoleConfidence,
  RoleLabel,
};

export function getContactConversation(
  correspondentId: string,
  opts?: { cursor?: string; limit?: number },
): Promise<ContactConversation> {
  const params = new URLSearchParams();
  if (opts?.cursor) params.set('cursor', opts.cursor);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  const qs = params.toString();
  return apiRequest<ContactConversation>(
    `/api/crm/correspondents/${encodeURIComponent(correspondentId)}/conversation${qs ? `?${qs}` : ''}`,
  );
}

export function requestRelationshipOverview(
  correspondentId: string,
): Promise<RelationshipOverview> {
  return apiRequest<RelationshipOverview>(
    `/api/crm/correspondents/${encodeURIComponent(correspondentId)}/conversation/overview`,
    { method: 'POST' },
  );
}
