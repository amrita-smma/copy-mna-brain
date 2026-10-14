/**
 * @crm_contact's identity, in a module with **no imports at all**.
 *
 * Three callers need the agent_name and must not pay for the agent to get it:
 * `CrmContactEnrichmentService` (stamps it on the queue row), the workforce
 * runtime (routes a claimed row to this agent's graph), and the API route.
 * Importing `./index` for the constant would drag LangChain into the service
 * container and into the workflow bundle — this file exists so none of them do.
 */

/** `ai_workforce_queue.agent_name` for a contact-enrichment run. */
export const CRM_CONTACT_AGENT_NAME = 'crm_contact';

/** Does this queue row belong to @crm_contact? */
export function isCrmContactAgent(agentName: string | null | undefined): boolean {
  return agentName === CRM_CONTACT_AGENT_NAME;
}

/**
 * Correspondent fields @crm_contact may write. Every one is a
 * `correspondent_curation` column — the human/agent overlay that
 * `correspondent_effective` COALESCEs over the ingest-owned base row
 * (RFC §3.4), so a later MBOX re-ingest can never clobber what was found.
 *
 * Deliberately absent:
 *   - `email` — the natural key behind the `(employer_id, email)` ingest
 *     upsert, and the one editable field that lives on the BASE table. A
 *     guessed address written there would re-key the row and split the
 *     person's email history in two.
 *   - `name` — not a "profile field": it is never empty, so it never shows
 *     up as a gap. `update_crm_contact` takes it as a separate argument and
 *     only accepts a completion/correction of the same person's name
 *     (`isNameCorrection`), because renaming to someone else is how a
 *     confident-but-wrong match becomes invisible.
 */
export const CRM_CONTACT_WRITABLE_FIELDS = [
  'title',
  'phone',
  'type',
  'department',
  'specialization',
  'seniority',
  'coverage_region',
  'linkedin_url',
  'bio',
] as const;

export type CrmContactWritableField = (typeof CRM_CONTACT_WRITABLE_FIELDS)[number];

/**
 * Which writable fields currently hold nothing.
 *
 * Lives here, with no imports, because three places need the same answer and
 * must not drift: the read tool (to tell the model what the job is), the write
 * tool (to refuse to flatten a field a colleague filled) and the enrichment
 * service (to put the gap list in the run's instruction, and to decide there
 * is nothing to do).
 *
 * Callers pass an EFFECTIVE row — `correspondent_effective`, which has already
 * COALESCEd the `correspondent_curation` overlay over the ingest-owned base.
 * A field a human filled by hand therefore reads as present, and stays
 * untouched.
 */
export function missingProfileFields(
  contact: Partial<Record<CrmContactWritableField, string | null>>,
): CrmContactWritableField[] {
  return CRM_CONTACT_WRITABLE_FIELDS.filter((field) => !contact[field]?.trim());
}
