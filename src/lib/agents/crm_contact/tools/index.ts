/**
 * @crm_contact's tool set — small on purpose.
 *
 * The agent does one thing: look a known person up on the public web and
 * record what it can prove. So it gets exactly what that needs —
 *
 *   - read_contact_emails — the email context first: the shared relationship
 *     overview, the role signals and the notes on their emails with us. A Workforce run
 *     may read every note, so the trace redacts this tool's output; only the
 *     run's report and the fields it writes are shared.
 *   - get_crm_contact / update_crm_contact — its own read and write. The write reaches `correspondent_curation`
 *     (the override table) through `CRMService.updateContact`; nothing here
 *     can touch the ingest-owned base row.
 *   - SERVER_TOOLS (Anthropic-hosted web_search / web_fetch) — the public
 *     record. Reused from the analysis agent so there is one definition of the
 *     server-tool config and its `allowed_callers` / `max_uses` tuning.
 *   - enrich_crm_contact — one structured people-data lookup through treg.to
 *     (`treg.people.enrich`), keyed on the contact's email / name + domain /
 *     LinkedIn URL. Cheap, and it usually hands back a full name, title and
 *     LinkedIn URL for the web searches to anchor on. When the record has no
 *     phone it also runs `treg.people.phone.find` (HLR-checked). A vendor
 *     record, so the prompt treats it like an aggregator, not proof.
 *   - valyu_search — filings and research, for firms whose people never appear
 *     on an ordinary team page.
 *   - narrate_step — the workforce trace contract, so the run renders in the
 *     Reasoning panel like any other workforce task.
 *
 * Deliberately absent: every pipeline tool (add / promote / drop / update
 * company), the insight tools, send_email, and the rest of the CRM surface. A
 * run that can only read one contact and write that contact's overlay has a
 * blast radius of one row — which is what makes it safe to fire from a button
 * with no approval step. `report_progress` is out too: a single-person lookup
 * has no list to iterate, so offering it only invites a stale one.
 */
import { SERVER_TOOLS, narrateStep, valyuSearch } from '@/lib/agents/analysis/tools';
import { enrichCrmContact } from './enrich_crm_contact';
import { getCrmContact } from './get_crm_contact';
import { readContactEmails } from './read_contact_emails';
import { updateCrmContact } from './update_crm_contact';
import { enrichCompanyContact } from './enrich_company_contact';
import { getCompanyForContacts } from './get_company_for_contacts';
import { saveCompanyContacts } from './save_company_contacts';

export { enrichCrmContact, enrichCrmContactSchema } from './enrich_crm_contact';
export type { EnrichCrmContactInput } from './enrich_crm_contact';
export { getCrmContact } from './get_crm_contact';
export { readContactEmails } from './read_contact_emails';
export { updateCrmContact, updateCrmContactSchema } from './update_crm_contact';
export type { UpdateCrmContactInput } from './update_crm_contact';
export { enrichCompanyContact, enrichCompanyContactSchema } from './enrich_company_contact';
export type { EnrichCompanyContactInput } from './enrich_company_contact';
export { getCompanyForContacts } from './get_company_for_contacts';
export { saveCompanyContacts, saveCompanyContactsSchema } from './save_company_contacts';
export type { SaveCompanyContactsInput } from './save_company_contacts';

export const CRM_CONTACT_TOOLS = [
  ...SERVER_TOOLS,
  getCrmContact,
  readContactEmails,
  enrichCrmContact,
  updateCrmContact,
  valyuSearch,
  narrateStep,
];

/**
 * The company-contacts task's tool set: find the partnership contacts AT a
 * pipeline company. Same shape and the same exclusions as above — its only
 * write files people under that one company's CRM firm (linking or creating
 * it), merging into existing contacts by filling empty fields only. It can
 * neither delete a contact nor rename one, nor change an email.
 */
export const CRM_COMPANY_CONTACTS_TOOLS = [
  ...SERVER_TOOLS,
  getCompanyForContacts,
  enrichCompanyContact,
  saveCompanyContacts,
  valyuSearch,
  narrateStep,
];
