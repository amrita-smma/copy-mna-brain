import { apiRequest } from '@/lib/api/client';
import type {
  ContactDealLink,
  ContactDealSuggestion,
  DealContactLinkState,
  DealContactRole,
} from '@/lib/services/dealContactService';

export type { ContactDealLink, ContactDealSuggestion, DealContactRole };

function dealsPath(correspondentId: string, companyId?: string): string {
  const base = `/api/crm/correspondents/${encodeURIComponent(correspondentId)}/deals`;
  return companyId ? `${base}/${encodeURIComponent(companyId)}` : base;
}

/** Manually link a contact to a deal (overrides an automatic or dismissed link). */
export function addContactDeal(
  correspondentId: string,
  companyId: string,
  role: DealContactRole,
): Promise<DealContactLinkState> {
  return apiRequest<DealContactLinkState>(dealsPath(correspondentId), {
    method: 'POST',
    body: JSON.stringify({ companyId, role }),
  });
}

/** Remove a link; it is kept as dismissed so nothing automatic re-adds it. */
export function removeContactDeal(
  correspondentId: string,
  companyId: string,
): Promise<DealContactLinkState> {
  return apiRequest<DealContactLinkState>(dealsPath(correspondentId, companyId), {
    method: 'DELETE',
  });
}

/** Confirm a suggested deal: the contact becomes `involved`. */
export function confirmContactDealSuggestion(
  correspondentId: string,
  companyId: string,
): Promise<DealContactLinkState> {
  return apiRequest<DealContactLinkState>(`${dealsPath(correspondentId, companyId)}/confirm`, {
    method: 'POST',
  });
}

/** Dismiss a suggested deal for good. */
export function dismissContactDealSuggestion(
  correspondentId: string,
  companyId: string,
): Promise<DealContactLinkState> {
  return apiRequest<DealContactLinkState>(`${dealsPath(correspondentId, companyId)}/dismiss`, {
    method: 'POST',
  });
}
