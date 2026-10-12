/**
 * @crm_contact's tool set — small on purpose.
 *
 * The agent does one thing: look a known person up on the public web and
 * record what it can prove. So it gets exactly what that needs —
 *
 *   - get_crm_contact / update_crm_contact — its own read and write, the only
 *     two tools in this folder. The write reaches `correspondent_curation`
 *     (the override table) through `CRMService.updateContact`; nothing here
 *     can touch the ingest-owned base row.
 *   - SERVER_TOOLS (Anthropic-hosted web_search / web_fetch) — the public
 *     record. Reused from the analysis agent so there is one definition of the
 *     server-tool config and its `allowed_callers` / `max_uses` tuning.
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
import { getCrmContact } from './get_crm_contact';
import { updateCrmContact } from './update_crm_contact';

export { getCrmContact } from './get_crm_contact';
export { updateCrmContact, updateCrmContactSchema } from './update_crm_contact';
export type { UpdateCrmContactInput } from './update_crm_contact';

export const CRM_CONTACT_TOOLS = [
  ...SERVER_TOOLS,
  getCrmContact,
  updateCrmContact,
  valyuSearch,
  narrateStep,
];
