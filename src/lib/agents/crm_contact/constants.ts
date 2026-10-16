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

/**
 * `ai_workforce_queue.agent_name` for @crm_contact's second task: find the
 * partnership contacts AT a pipeline company (the Details tab's "Contact
 * Details" card), rather than fill in one CRM correspondent. Same agent, its
 * own prompt and tool list — a separate name because the runtime picks the
 * graph by agent_name, and because the queue lookups that drive each button
 * must not see the other task's runs.
 */
export const CRM_COMPANY_CONTACTS_AGENT_NAME = 'crm_company_contacts';

/** Does this queue row belong to @crm_contact's company-contacts task? */
export function isCrmCompanyContactsAgent(agentName: string | null | undefined): boolean {
  return agentName === CRM_COMPANY_CONTACTS_AGENT_NAME;
}

/** How many contacts a company-contacts run keeps — the card shows the top N. */
export const MAX_COMPANY_CONTACTS = 5;

/**
 * Title patterns, best partnership contact first. The card ranks the
 * company's CRM contacts by the first pattern a title matches, so contacts
 * from any source — this agent, the mailbox ingest, a CSV import, a human —
 * sort the same way. Order matters: "Business Development Manager" must hit
 * the BD tiers before a generic "manager".
 */
const PARTNERSHIP_TITLE_TIERS: readonly RegExp[] = [
  /\b(ceo|chief executive|managing director|president|founder|co-founder|owner|presiden direktur|direktur utama)\b/i,
  /\b(cbo|cco|cso|chief (business|commercial|strategy|revenue|growth|partnership)s? officer)\b/i,
  /\b(vp|vice president|head|director|svp|evp|gm|general manager)\b.*\b(business development|bd|partnerships?|alliances?|corporate development|strategy|commercial)\b/i,
  /\b(business development|bd|partnerships?|alliances?|corporate development)\b/i,
  /\b(country manager|general manager|gm)\b/i,
  /\b(coo|cfo|cto|chief)\b/i,
];

/**
 * 0 = best partnership contact; `PARTNERSHIP_TITLE_TIERS.length` = no
 * recognisable partnership role (or no title).
 */
export function partnershipRoleRank(title: string | null | undefined): number {
  const t = title?.trim();
  if (!t) return PARTNERSHIP_TITLE_TIERS.length;
  const tier = PARTNERSHIP_TITLE_TIERS.findIndex((re) => re.test(t));
  return tier === -1 ? PARTNERSHIP_TITLE_TIERS.length : tier;
}

/**
 * Hosts that are not a company's own domain: a "website" pointing at a
 * social profile or a site builder. Claiming one in `employer_domains` would
 * file every future email from that host under this company.
 */
const SHARED_WEB_HOSTS = new Set([
  'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'medium.com', 'linktr.ee', 'google.com',
  'sites.google.com', 'wixsite.com', 'blogspot.com', 'wordpress.com',
  'notion.site', 'github.com', 'crunchbase.com',
]);

/**
 * `https://www.acme.co.id/about` → `acme.co.id`. The company's website is the
 * best identity anchor a company-contacts run has, the domain is what treg
 * matches a person against, and it is how a company is matched to its CRM
 * employer. `undefined` for an empty, unparseable or shared host.
 */
export function domainFromWebsite(website: string | null | undefined): string | undefined {
  const raw = website?.trim();
  if (!raw) return undefined;
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/^www\./i, '').toLowerCase();
  if (!host.includes('.')) return undefined;
  const shared = [...SHARED_WEB_HOSTS].some((h) => host === h || host.endsWith(`.${h}`));
  return shared ? undefined : host;
}
