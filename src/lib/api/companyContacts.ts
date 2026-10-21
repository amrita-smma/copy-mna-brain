import { apiRequest } from '@/lib/api/client';
import type {
  BulkContactDiscoveryResult,
  CompanyContactsState,
} from '@/lib/services/companyContactDiscoveryService';
import type { ContactEnrichmentRun } from '@/lib/services/crmContactEnrichmentService';

export type { BulkContactDiscoveryResult, CompanyContactsState, ContactEnrichmentRun };
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

/** Contacts state for a page of companies in one request, keyed by company id. */
export function getCompaniesContacts(
  companyIds: string[],
): Promise<Record<string, CompanyContactsState>> {
  const params = new URLSearchParams({ ids: companyIds.join(',') });
  return apiRequest<Record<string, CompanyContactsState>>(`/api/companies/contacts?${params}`);
}

/** Queue a contact search for each company; `onlyMissing` skips ones already searched. */
export function findCompaniesContacts(
  companyIds: string[],
  opts: { onlyMissing?: boolean } = {},
): Promise<BulkContactDiscoveryResult> {
  return apiRequest<BulkContactDiscoveryResult>('/api/companies/contacts', {
    method: 'POST',
    body: JSON.stringify({ companyIds, onlyMissing: opts.onlyMissing ?? false }),
  });
}
