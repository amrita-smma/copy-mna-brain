import { apiRequest } from '@/lib/api/client';
import type { CompanyContactsState } from '@/lib/services/companyContactDiscoveryService';
import type { ContactEnrichmentRun } from '@/lib/services/crmContactEnrichmentService';

export type { CompanyContactsState, ContactEnrichmentRun };
export type CompanyContact = CompanyContactsState['contacts'][number];
export type CompanyCrmEmployer = NonNullable<CompanyContactsState['employer']>;

/**
 * Client wrappers for a company's CRM partnership contacts (the company dialog's
 * Contact Details card) and the @crm_contact run that finds them.
 */

const contactsPath = (companyId: string) =>
  `/api/companies/${encodeURIComponent(companyId)}/contacts`;

/** The company's CRM firm, its contacts (best partnership contact first) and the latest run. */
export function getCompanyContacts(companyId: string): Promise<CompanyContactsState> {
  return apiRequest<CompanyContactsState>(contactsPath(companyId));
}

/** Queue a discovery run, or join the one already in flight. */
export function findCompanyContacts(
  companyId: string,
): Promise<ContactEnrichmentRun & { created: boolean }> {
  return apiRequest<ContactEnrichmentRun & { created: boolean }>(contactsPath(companyId), {
    method: 'POST',
  });
}
