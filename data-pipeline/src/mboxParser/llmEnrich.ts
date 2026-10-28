// Shared logic for the LLM enrichment step. Mirrors mna-mbox-parser/llm_extract.py.
// Pure functions (prompt builder, merge step, schema, system prompt). Anything
// Network I/O lives in the single-pass email processor so this module remains
// testable without network access.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { Candidate } from './extract';
import { INTERNAL_MAIL_DOMAINS } from '../lib/mailDomains';

// ─── Types ───────────────────────────────────────────────────────────────────

const ROLE_LABELS = [
  'funding',
  'lending',
  'finance',
  'tax',
  'advisory',
  'legal',
  'due_diligence',
  'principal',
  'other',
] as const;
export type RoleLabel = (typeof ROLE_LABELS)[number];
export type RoleConfidence = 'high' | 'medium' | 'low';

export interface LlmCounterpartyRole {
  address: string;                       // must be one of the [external] PARTICIPANTS
  label: RoleLabel;
  confidence: RoleConfidence;
  evidence: string;                      // one sentence, paraphrased, no quotes
}

export interface LlmEmailNote {
  /** The model's verdict against DEAL_NOTE_RUBRIC; absent on a sanitized note. */
  is_deal_related?: boolean;
  summary: string | null;                // 1–2 sentences; null when nothing substantive
  key_points: string[];                  // 0–4 short paraphrased points
  next_step: string | null;
  next_step_status: 'action' | 'done' | 'none';
  sentiment: 'positive' | 'neutral' | 'negative';
  counterparty_roles: LlmCounterpartyRole[];
}

export interface QueueParticipant {
  role: 'from' | 'to' | 'cc';
  address: string;
}

export interface QueueEntry {
  message_id: string;
  subject: string;
  sender_email: string;
  domain_tag: string | null;
  participants: QueueParticipant[];
  payload: {
    body_snippet: string;
    thread_context?: string;
    candidates: Candidate[];
    want_topics: boolean;
    want_names: boolean;
    want_related_companies: boolean;
  };
}

// What the LLM returns (raw, pre-merge).
export interface LlmPerson {
  name: string | null;
  role: string | null;
  company: string | null;
  specialization?: string | null;
  coverage_region?: string | null;
  candidate_indices: number[];
}

export interface LlmRelatedCompany {
  company_name: string;
  /** @deprecated Ephemeral pipeline does not retain body excerpts. */
  matched_text?: string | null;
  reason: 'explicit_pitch' | 'company_mention' | 'deal_keyword_context' | 'process_reference' | 'other';
  reason_summary: string;
  keywords: string[];
  confidence: 'high' | 'medium' | 'low';
}

export interface LlmTopic {
  name: string;
  is_deal_related: boolean;
}

export interface LlmExtraction {
  // true when the email is personal/social or a 1-1 catch-up with no business
  // substance. Such emails are dropped and NOT ingested as CRM evidence.
  is_personal?: boolean;
  topics: LlmTopic[];
  people: LlmPerson[];
  related_companies: LlmRelatedCompany[];
  email_note: LlmEmailNote;
}

// After merging LLM output back with the deterministic email/phone values.
export interface EnrichedPerson {
  name: string | null;
  role: string | null;
  company: string | null;
  /** Sector / product focus stated in the context (the CRM's Industry Focus). */
  specialization: string | null;
  /** Markets they cover stated in the context (the CRM's Area Focus). */
  coverage_region: string | null;
  email: string | null;
  phone: string | null;
}

export interface EnrichedRecord {
  message_id: string;
  sender_email?: string;
  domain_tag?: string | null;
  topics: string[];
  people: EnrichedPerson[];
}

export interface EnrichmentError {
  message_id: string;
  error: string;
}

export type EnrichmentResult = EnrichedRecord | EnrichmentError;

// ─── Schema (JSON Schema for Anthropic tool_use; mirrors Python's pydantic) ──

/**
 * Which emails earn a CRM note. Shared by the extraction prompt's NOTE RULES
 * and the reclassification of stored notes (`emailNoteReclassify`), so a note
 * written today and a note re-judged later meet the same bar.
 */
export const DEAL_NOTE_RUBRIC = `An email is deal-related when it moves or informs a transaction: a company for sale or being acquired, a target or opportunity being pitched or screened, a mandate, fundraising or financing for a specific deal or company, due diligence, valuation, deal terms (NDA, LOI, term sheet, SPA), a named Project, or a counterparty's role in one of these. A deal's process timetable, bid deadlines, data room access, or a request for or sharing of deal documents is deal-related.
It is NOT deal-related when it is only:
- arranging, rescheduling or confirming a meeting or call, an office visit, a room booking or a calendar invite. This holds even when the meeting is about a deal; it counts only if the email itself also carries deal substance (terms, numbers, a decision, a document's content or a process step).
- an acknowledgement, "thanks", "noted", "received", or an out-of-office reply
- admin or operations: invoices, expenses, payroll, HR, IT, office matters
- a newsletter, marketing, an event invitation, or market/sector commentary not tied to a specific transaction
- relationship chat with no transaction in it`;

/**
 * How a note that is already deal-related may mention a meeting. Notes are read
 * back to the deal team and fed into shared relationship overviews, so a
 * meeting is named only as having been proposed or held — never when, where or
 * how to join it. Shared by the extraction prompt's NOTE RULES and the stored
 * note reclassification pass. It never decides is_deal_related.
 */
export const MEETING_NOTE_RULE = `This rule shapes the text of a note already judged deal-related; it never changes is_deal_related.
- Mention a meeting or call only generically: "proposed a meeting to discuss the acquisition", "met management". Never state its date, day, time, time zone, venue, office, city, room, video link, dial-in or passcode.
- A next step that is only booking, confirming, attending or rescheduling a meeting or call is not a next step. Write the next move on the deal instead (e.g. "await the firm's response on advising the deal"), or next_step = null and next_step_status = "none" when there is none.
- Do not record who has or has not replied to a scheduling request.`;

export const EMAIL_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    is_personal: {
      type: 'boolean',
      description:
        "true ONLY if the email is personal/social in nature or a 1-1 catch-up with NO business or deal substance (e.g. birthday/congrats/condolences, arranging coffee/lunch/drinks, scheduling or recapping a 1:1, personal thanks). When true the email is dropped and NOT ingested. Be conservative: if there is ANY deal or business substance, set false. See PERSONAL / NON-BUSINESS RULE.",
    },
    topics: {
      type: 'array',
      description:
        "0-5 business-substance topic tags. Each has a kebab-case name and a deal classification. Empty array is fine — do NOT include procedural/admin/scheduling/file-handling tags. See SYSTEM_PROMPT TOPIC RULES for full guidance.",
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: "Kebab-case tag (e.g. 'nda', 'term-sheet', 'semiconductors', 'waste-to-energy').",
          },
          is_deal_related: {
            type: 'boolean',
            description: "true = deal mechanics / deal stage / project codename; false = industry/sector/substance not directly tied to a transaction.",
          },
        },
        required: ['name', 'is_deal_related'],
      },
    },
    people: {
      type: 'array',
      description:
        'One Person per unique person who owns at least one CANDIDATE. If no CANDIDATES were provided in the prompt, return [].',
      items: {
        type: 'object',
        properties: {
          name: {
            type: ['string', 'null'],
            description: "Person's name as written in the candidate's context; null if not identifiable from context",
          },
          role: {
            type: ['string', 'null'],
            description: 'Job title or role from context; null if not in context',
          },
          company: {
            type: ['string', 'null'],
            description: 'Company or organization from context; null if not in context',
          },
          specialization: {
            type: ['string', 'null'],
            description:
              'Industry / sector or product focus stated in the context, e.g. "Industrials", "TMT", "Healthcare", "Leveraged Finance"; null if not stated. See PEOPLE RULES.',
          },
          coverage_region: {
            type: ['string', 'null'],
            description:
              'Geography of the markets they cover, stated in the context, e.g. "Southeast Asia", "Greater China"; null if not stated. NEVER an office address or city. See PEOPLE RULES.',
          },
          candidate_indices: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
            description:
              'REQUIRED: indices [0, 1, ...] of the input CANDIDATES that belong to this person. If a person has both an email and phone candidate in the same signature, include BOTH indices.',
          },
        },
        required: ['name', 'role', 'company', 'specialization', 'coverage_region', 'candidate_indices'],
      },
    },
    related_companies: {
      type: 'array',
      description:
        'Target or opportunity companies mentioned in a deal-relevant context. Empty array if nothing qualifies. See RELATED COMPANIES RULES.',
      items: {
        type: 'object',
        properties: {
          company_name: { type: 'string', description: 'Short company name, no email addresses.' },
          reason: {
            type: 'string',
            enum: ['explicit_pitch', 'company_mention', 'deal_keyword_context', 'process_reference', 'other'],
          },
          reason_summary: { type: 'string', description: 'One sentence.' },
          keywords: { type: 'array', items: { type: 'string' }, description: '0-8 deal keywords found near the mention.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        // Intentionally omit matched_text — ephemeral cutover does not retain
        // verbatim subject/body excerpts in model output or CRM evidence.
        required: ['company_name', 'reason', 'reason_summary', 'keywords', 'confidence'],
      },
    },
    email_note: {
      type: 'object',
      description:
        'Deal-substance email note and counterparty deal roles. Paraphrase only, never quote the email verbatim. Summary must be null for emails with nothing substantive (acknowledgements, scheduling, "thanks").',
      properties: {
        is_deal_related: {
          type: 'boolean',
          description:
            'true ONLY if the email is deal-related under NOTE RULES. false for meeting scheduling (including office meetings), acknowledgements, admin, newsletters and relationship chat; a false note is discarded.',
        },
        summary: {
          type: ['string', 'null'],
          description:
            '1-2 sentence business substance summary. Paraphrase only, never quote verbatim. A meeting is mentioned only generically, never its date, time, place or link (MEETING RULE). null if the email has no business or deal substance (e.g. acknowledgements, scheduling, "thanks").',
        },
        key_points: {
          type: 'array',
          items: { type: 'string' },
          description:
            '0-4 short paraphrased key business points. Never quote verbatim.',
        },
        next_step: {
          type: ['string', 'null'],
          description:
            'Concrete next step on the deal if mentioned; null otherwise. Never booking, confirming or rescheduling a meeting (MEETING RULE). Paraphrase only.',
        },
        next_step_status: {
          type: 'string',
          enum: ['action', 'done', 'none'],
          description:
            'action = pending action needed; done = action completed; none = no actionable next step.',
        },
        sentiment: {
          type: 'string',
          enum: ['positive', 'neutral', 'negative'],
          description: 'Overall tone / sentiment of the communication.',
        },
        counterparty_roles: {
          type: 'array',
          description:
            'Counterparty deal roles for [external] participants who have real deal role evidence in the email. Return empty array [] if no external participant has clear role evidence. See ROLE RULES.',
          items: {
            type: 'object',
            properties: {
              address: {
                type: 'string',
                description:
                  'Email address of the participant (must be one of the [external] PARTICIPANTS listed).',
              },
              label: {
                type: 'string',
                enum: ROLE_LABELS,
                description: 'Inferred deal role.',
              },
              confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: 'Confidence in this role inference.',
              },
              evidence: {
                type: 'string',
                description:
                  'One-sentence paraphrase explaining the evidence for this role. Never quote the email verbatim.',
              },
            },
            required: ['address', 'label', 'confidence', 'evidence'],
          },
        },
      },
      required: [
        'is_deal_related',
        'summary',
        'key_points',
        'next_step',
        'next_step_status',
        'sentiment',
        'counterparty_roles',
      ],
    },
  },
  required: ['is_personal', 'topics', 'people', 'related_companies', 'email_note'],
} as const;

export const EMAIL_NOTE_SCHEMA = {
  type: 'object',
  properties: {
    email_note: EMAIL_EXTRACTION_SCHEMA.properties.email_note,
  },
  required: ['email_note'],
} as const;

// ─── Prompts (verbatim from the Python original — well-tested phrasing) ──────

export const SYSTEM_PROMPT = `You extract structured info from a single email.

PERSONAL / NON-BUSINESS RULE:
Set is_personal = true ONLY when the email is personal/social or a pure 1-1
catch-up with NO deal or business substance. Examples that ARE personal:
- Birthday / congratulations / condolences / get-well notes
- Arranging or recapping coffee, lunch, dinner, drinks, a "catch up", or a 1:1
  with no business agenda
- Personal thank-you notes with no deal content
Set is_personal = false when there is ANY business/deal substance — even if the
email also mentions a meal or a 1:1. When in doubt, choose false. Deal language
(NDA, term sheet, due diligence, valuation, mandate, acquisition, a named
Project, etc.) always means is_personal = false.

PEOPLE RULES:
- Each CANDIDATE has an [index], a type (EMAIL or PHONE), a value, and a CONTEXT.
- Read the CONTEXT to find a name attached to the candidate. Names usually appear DIRECTLY before the address, e.g. "John Smith <john@acme.com>", "Sarah Lim sarah.lim@firm.com", or in a signature block right above the address.
- If the same person owns multiple candidates (e.g. email and phone in the same signature), output ONE Person with all their candidate indices in \`candidate_indices\`.
- Use ONLY what is explicitly in the CONTEXT for name/role/company/specialization/coverage_region. If something isn't there, return null. NEVER invent.
- specialization is the sector or product the person covers, as their title or signature states it: "Managing Director, Industrials Group" → "Industrials"; "Head of TMT Coverage" → "TMT". Write it short, without "Group"/"Coverage"/"Team". Do NOT infer it from the firm's business or from what the email discusses.
- coverage_region is the geography of their mandate, as their title or signature states it: "Head of M&A, Southeast Asia" → "Southeast Asia"; "Director, Greater China Coverage" → "Greater China". It is NOT where they sit: an office address, a city under the signature or a phone country code never fills it. A Singapore office address alone means null.
- If NO candidates were provided, return an empty people list. Do NOT extract people from the email body alone.

EXAMPLE INPUT:
CANDIDATES:
[0] EMAIL: john.smith@goldmansachs.com
    CONTEXT: Best regards, John Smith Managing Director, Industrials Group Goldman Sachs +1 (212) 555-0100 john.smith@goldmansachs.com
[1] PHONE: +12125550100
    CONTEXT: Best regards, John Smith Managing Director, Industrials Group Goldman Sachs +1 (212) 555-0100 john.smith@goldmansachs.com
[2] EMAIL: jen@startup.io
    CONTEXT: forwarded message from jen@startup.io subject: re intro

EXAMPLE OUTPUT:
{
  "people": [
    {"name": "John Smith", "role": "Managing Director, Industrials Group", "company": "Goldman Sachs", "specialization": "Industrials", "coverage_region": null, "candidate_indices": [0, 1]},
    {"name": null, "role": null, "company": null, "specialization": null, "coverage_region": null, "candidate_indices": [2]}
  ]
}

THING TO CONSIDER:
- sender_email is the email of the sender of the email

TOPIC RULES:
Emit 0-5 topic objects, each with a kebab-case "name" and an "is_deal_related" boolean.
Empty array is fine and better than noise.
Take topics from SUBJECT and EMAIL BODY only, never from EARLIER IN THREAD.

is_deal_related = true — directly tied to a transaction or deal process:
- Deal mechanics: nda, term-sheet, due-diligence, valuation, mou, loi, signing, mandate, acquisition, financing
- Project codenames mentioned in the email: project-domino, project-olive
- Deal stage / activity: intro, market-sounding, regulatory-filing, fundraising, exit, ipo

is_deal_related = false — industry, sector, or substantive context not tied to a specific transaction:
- Industry / sector: semiconductors, waste-to-energy, real-estate, infrastructure, fintech, cmp-slurry, lithography
- Substantive subject matter — only when the email is genuinely ABOUT the analysis, not just
  transmitting a file: bankability-study, capex-analysis, financial-model, valuation-review

AVOID — NEVER emit topics about:
- Document/file handling: document-submission, document-revision, appendix-*, file-*,
  attachment-*, translation, format-change, signature-request
- Meeting / scheduling admin: meeting-attendance, meeting-confirmation, meeting-follow-up,
  meeting-request, meeting-scheduling, scheduling, virtual-meeting
- Generic procedural: approval, deadline, follow-up, acknowledgement, forwarded-message,
  fyi, business-discussion, business-meeting, internal-approval
- Compliance procedure (vs substance): compliance, compliance-documentation, ubo-request,
  declaration-letter, support-letter, parent-company-support-letter
- Company / entity names — these are tracked as employers, not topics. Never emit
  samsung, star-capital, goldman-sachs, jpm, sinarmas, etc.
- IT / system access: file-access, password-protection, login-access, sharepoint

If no GOOD topic applies to this email, return an empty topics list. Do not pad with
procedural tags to hit the 1-5 minimum.

RELATED COMPANIES RULES:
Extract ONLY companies that are THEMSELVES the subject of a transaction — being sold, acquired, or receiving investment. Empty array if nothing qualifies.
Take companies from SUBJECT and EMAIL BODY only. A company named only in EARLIER IN THREAD is not related to this email: leave it out even when this email clearly refers to it.

INCLUDE:
- Explicit sell-side / M&A mandate: "We represent X", "Mandated for X", "sell-side process for X", "X is for sale", "disposal of X", "carve-out of X", "acquisition of X", "merger involving X"
- VC / PE investment target: "term sheet for X", "Series A/B/C for X", "investing in X", "investment opportunity in X", "deal for X", "round for X"
- Named deal projects (codenames): "Project Alpha", "Project Domino" — only when it clearly refers to a live deal, not a generic phrase

EXCLUDE — NEVER extract:
- The sender's own bank, advisory firm, or any other bank / advisor involved in the process
- The acquirer or buyer (the company paying, not the target being bought)
- Holding companies, blank-cheque SPVs, or generic fund names without a named operating company
- Service providers in the deal (law firms, accounting firms, consultants, printers)
- Market comparables or valuation benchmarks ("similar to X", "like X trades at…")
- Companies mentioned only as background context or market colour
- Casual conference / social mentions ("I met X at an event", "X was in the news")
- People names, sector names, geographic names

Use 'high' ONLY for explicit mandate / pitch language. Use 'medium' for clear deal-keyword context. Use 'low' for plausible but ambiguous signals.
If nothing qualifies, return [].

NOTE RULES:
- Extract a concise business-substance note for the email.
- Paraphrase only: NEVER quote the email body or subject verbatim. All text must be derived/paraphrased.
- Deal substance only. Set is_deal_related against this rubric:
${DEAL_NOTE_RUBRIC}
- When is_deal_related = false, set summary = null, key_points = [], next_step = null, next_step_status = "none", sentiment = "neutral". The note is discarded, so do not write one.
- If the email is purely administrative, scheduling, an acknowledgement or "thanks", also set counterparty_roles = [].
- summary: 1-2 sentences capturing the substantive business discussion; null if nothing substantive.
- key_points: 0-4 short paraphrased bullet points.
- next_step: next action on the deal if any, or null.
- MEETING RULE:
${MEETING_NOTE_RULE}
- next_step_status: 'action' if action is pending, 'done' if completed, 'none' if no next step.
- sentiment: 'positive', 'neutral', or 'negative'.
- EARLIER IN THREAD, when present, is the quoted history under this email. Use it ONLY to understand what this email refers to (e.g. which option a reply agrees to). The note covers what THIS email adds; never summarise the earlier messages for their own sake.

ROLE RULES:
- Infer the role in investment/transactions for participants, based ONLY on evidence in the email. EARLIER IN THREAD may clarify what this email means, but a role needs evidence in this email's own body.
- IMPORTANT: Roles apply ONLY to [external] participants listed in PARTICIPANTS. NEVER infer roles for [internal] participants.
- Only emit a role when the email gives real evidence of what that external person or their firm does in a deal. If no clear evidence, emit an empty array [].
- Role labels:
  - funding: equity/fund-raising, capital commitments, LP/co-investment.
  - lending: debt, loans, credit facilities.
  - finance: financial analysis, models, valuation, CFO-type work.
  - tax: tax structuring/advice.
  - advisory: M&A / sell-side / buy-side advisory, mandates, deal origination.
  - legal: legal counsel, documentation, NDAs/SPAs.
  - due_diligence: third-party financial, accounting, technical, commercial or ESG due diligence on a target.
  - principal: an owner, founder, shareholder or executive of the company being sold or raising capital, acting for that company. Never a buyer or investor (use funding), and never an advisor.
  - other: a clear deal role that none of the labels above fit; the evidence sentence must say what the role is.
- Prefer a specific label over 'other'. Never use 'other' for a participant with no clear deal role: emit nothing instead.
- confidence: 'high' for explicit role statement or clear transaction role; 'medium' for strong contextual evidence; 'low' for plausible inference.
- evidence: ONE sentence paraphrasing the reason for the role inference. NEVER quote verbatim.

Output must be valid JSON matching the requested schema.`;

function isInternalAddress(address: string): boolean {
  return INTERNAL_MAIL_DOMAINS.has(address.split('@')[1] ?? '');
}

function formatParticipants(entry: QueueEntry): string[] {
  const lines: string[] = [];
  for (const p of entry.participants) {
    const address = p.address.trim().toLowerCase();
    if (!address) continue;
    const tag = isInternalAddress(address) ? '[internal]' : '[external]';
    lines.push(`${p.role.toUpperCase()}: ${address} ${tag}`);
  }
  return lines;
}

/**
 * The lower-cased participants outside our own domains: the only addresses a
 * counterparty role may name (`sanitizeEmailNote`).
 */
export function externalAddresses(from: string, to: string[], cc: string[]): Set<string> {
  const out = new Set<string>();
  for (const a of [from, ...to, ...cc]) {
    const address = a.toLowerCase();
    if (!isInternalAddress(address)) out.add(address);
  }
  return out;
}

// The quoted history, for the note only. Topics, related companies and names
// are told to ignore it: every reply quotes the original pitch, so mining it
// would re-count the same evidence once per reply.
function threadSection(payload: QueueEntry['payload']): string | null {
  const thread = (payload.thread_context ?? '').trim();
  if (!thread) return null;
  return `EARLIER IN THREAD (context for the note only; extract nothing else from it):\n${thread.slice(0, 3000)}`;
}

// Build the per-entry user prompt. Order matches the Python version exactly:
// TASK → CANDIDATES → PARTICIPANTS → SUBJECT → EMAIL BODY, then EARLIER IN
// THREAD when the note is wanted.
export function buildUserPrompt(entry: QueueEntry): string {
  const { payload } = entry;
  const sections: string[] = [];

  const wantNote = Boolean(payload.body_snippet);

  const instructions: string[] = [];
  if (payload.want_names) {
    instructions.push(
      '1. For each CANDIDATE below, identify which person owns it from its CONTEXT. Look for names DIRECTLY adjacent to the email/phone. Group candidates with the same context into a single Person.',
    );
  }
  if (payload.want_topics) {
    instructions.push(
      '2. Extract 0-5 business-substance topic tags from the EMAIL BODY (see TOPIC RULES). Empty list is acceptable when nothing substantive applies.',
    );
  }
  if (payload.want_related_companies) {
    instructions.push(
      '3. Extract related target/opportunity companies from the SUBJECT and EMAIL BODY (see RELATED COMPANIES RULES). Return [] if nothing qualifies.',
    );
  }
  if (wantNote) {
    instructions.push(
      '4. Generate an email note summarizing business substance and infer counterparty deal roles for [external] participants from SUBJECT and EMAIL BODY (see NOTE RULES and ROLE RULES).',
    );
  }
  sections.push(`TASK:\n${instructions.join('\n')}`);

  if (payload.want_names && payload.candidates.length > 0) {
    const candLines: string[] = [];
    payload.candidates.forEach((c, idx) => {
      candLines.push(`[${idx}] ${c.type.toUpperCase()}: ${c.value}`);
      candLines.push(`    CONTEXT: ${c.context}`);
    });
    sections.push(`CANDIDATES:\n${candLines.join('\n')}`);
  }

  const participantLines = formatParticipants(entry);
  if (participantLines.length > 0) {
    sections.push(`PARTICIPANTS:\n${participantLines.join('\n')}`);
  }

  if (entry.subject && (payload.want_topics || payload.want_related_companies || wantNote)) {
    sections.push(`SUBJECT:\n${entry.subject}`);
  }

  if (payload.want_topics || payload.want_related_companies || wantNote) {
    // Topics don't need 6000 chars; truncate further for cheaper calls.
    const body = payload.body_snippet.slice(0, 2000);
    sections.push(`EMAIL BODY:\n${body}`);
  }

  const thread = wantNote ? threadSection(payload) : null;
  if (thread) sections.push(thread);

  return sections.join('\n\n');
}

const LEGAL_NAME_TOKENS = new Set([
  'pt', 'tbk', 'persero', 'ltd', 'limited', 'inc', 'pte', 'llc', 'corp',
  'corporation', 'company', 'plc', 'gmbh', 'the',
]);

function wordText(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

/**
 * Drops related companies named only in EARLIER IN THREAD. The prompt says so,
 * but the model does not always comply, and every reply quotes the original
 * pitch: one leak per reply would re-count the same evidence. A company stays
 * when a distinctive word of its name (legal forms like PT/Tbk/Ltd aside)
 * appears in the email's own subject or body. Emails that quote nothing are
 * returned unchanged.
 */
export function dropThreadOnlyCompanies<T extends Partial<LlmExtraction>>(
  extraction: T | null,
  entry: QueueEntry,
): T | null {
  if (!extraction?.related_companies?.length) return extraction;
  if (!(entry.payload.thread_context ?? '').trim()) return extraction;
  const own = wordText(`${entry.subject}\n${entry.payload.body_snippet}`);
  const related_companies = extraction.related_companies.filter((rc) => {
    const name = wordText(rc?.company_name ?? '').trim();
    if (!name) return false;
    const words = name.split(' ').filter((w) => w.length >= 3 && !LEGAL_NAME_TOKENS.has(w));
    return words.length === 0
      ? own.includes(` ${name} `)
      : words.some((w) => own.includes(` ${w} `));
  });
  return { ...extraction, related_companies };
}

export function buildNoteOnlyPrompt(entry: QueueEntry): string {
  const { payload } = entry;
  const sections: string[] = [];

  sections.push(
    'TASK:\nGenerate an email note summarizing business substance and infer counterparty deal roles for [external] participants from SUBJECT and EMAIL BODY (see NOTE RULES and ROLE RULES).',
  );

  const participantLines = formatParticipants(entry);
  if (participantLines.length > 0) {
    sections.push(`PARTICIPANTS:\n${participantLines.join('\n')}`);
  }

  if (entry.subject) {
    sections.push(`SUBJECT:\n${entry.subject}`);
  }

  const body = (payload.body_snippet || '').slice(0, 2000);
  sections.push(`EMAIL BODY:\n${body}`);

  const thread = threadSection(payload);
  if (thread) sections.push(thread);

  return sections.join('\n\n');
}

const CONFIDENCE_RANK: Record<RoleConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Repairs a tool input where the model emitted `email_note` as a JSON string
 * instead of an object. The string opens with the note object, optionally
 * followed by a stray `"` and then the REST of the tool input (`{note},
 * "is_personal": …, "topics": […]}`), which drops every other field too. The
 * stray quote is dropped and `{"email_note":` is prefixed, which makes a spill
 * the full input again; when that does not parse, the leading note object
 * alone is kept. Anything else is returned unchanged; a note that cannot be
 * recovered sanitizes to null.
 */
export function repairToolInput<T>(input: T): T {
  if (!input || typeof input !== 'object') return input;
  const raw = (input as { email_note?: unknown }).email_note;
  if (typeof raw !== 'string') return input;
  const end = leadingObjectEnd(raw);
  if (end < 0) return input;
  const head = raw.slice(0, end);
  const rest = raw.slice(end).trimStart().replace(/^"/, '');
  for (const text of [`{"email_note":${head}${rest}`, `{"email_note":${head}}`]) {
    try {
      const whole: unknown = JSON.parse(text);
      if (isObject(whole) && isObject(whole.email_note)) return { ...input, ...whole };
    } catch {
      // try the note object alone
    }
  }
  return input;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Index just past the balanced `{…}` that opens `text`, or -1. */
function leadingObjectEnd(text: string): number {
  const start = text.search(/\S/);
  if (start < 0 || text[start] !== '{') return -1;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** The trimmed string, or null when it is not a string or is blank. */
function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim() || null;
}

/** `value` when it is one of `allowed`, else `fallback`. */
function oneOf<T extends string, F>(value: unknown, allowed: readonly T[], fallback: F): T | F {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function sanitizeEmailNote(
  note: unknown,
  externalAddrs: Iterable<string>,
): LlmEmailNote | null {
  if (!note || typeof note !== 'object' || Array.isArray(note)) {
    return null;
  }

  const raw = note as Record<string, unknown>;

  // A non-deal note is stored as one with no substance (summary null): the row
  // still exists so the note backfill never re-asks the model, and every CRM
  // read skips it. Only an explicit `false` drops the note — a missing flag (an
  // output salvaged by repairToolInput) keeps it rather than erasing it.
  const summary = raw.is_deal_related === false ? null : str(raw.summary);
  let keyPoints = Array.isArray(raw.key_points)
    ? raw.key_points.map(str).filter((kp): kp is string => kp !== null).slice(0, 4)
    : [];
  let nextStep = str(raw.next_step);
  let nextStepStatus = oneOf(raw.next_step_status, ['action', 'done', 'none'] as const, 'none');

  // An email with no substance (summary null) never carries key points or a
  // next step, whatever the model returned for them.
  if (summary === null) {
    keyPoints = [];
    nextStep = null;
    nextStepStatus = 'none';
  }

  const sentiment = oneOf(raw.sentiment, ['positive', 'neutral', 'negative'] as const, 'neutral');

  const extSet = new Set([...externalAddrs].map((a) => a.toLowerCase()));

  // Roles: drops unknown/internal address, bad label/confidence, lower-case address, dedupe by (address, label) keeping highest confidence
  const rolesByAddrLabel = new Map<string, LlmCounterpartyRole>();

  if (Array.isArray(raw.counterparty_roles)) {
    for (const r of raw.counterparty_roles) {
      if (!r || typeof r !== 'object') continue;
      const rObj = r as Record<string, unknown>;
      const rawAddr = typeof rObj.address === 'string' ? rObj.address.trim().toLowerCase() : '';
      if (!rawAddr || !extSet.has(rawAddr)) continue;

      const label = oneOf(rObj.label, ROLE_LABELS, null);
      const confidence = oneOf(rObj.confidence, ['high', 'medium', 'low'] as const, null);
      if (!label || !confidence) continue;

      const evidence = typeof rObj.evidence === 'string' ? rObj.evidence.trim() : '';

      const key = `${rawAddr}\0${label}`;
      const existing = rolesByAddrLabel.get(key);
      if (!existing || CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence]) {
        rolesByAddrLabel.set(key, {
          address: rawAddr,
          label,
          confidence,
          evidence,
        });
      }
    }
  }

  return {
    summary,
    key_points: keyPoints,
    next_step: nextStep,
    next_step_status: nextStepStatus,
    sentiment,
    counterparty_roles: Array.from(rolesByAddrLabel.values()),
  };
}

// The CRM shows a focus as one short tag; anything longer than this is a
// sentence the model copied, not a focus.
const MAX_FOCUS_CHARS = 120;

function focusValue(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  return v && v.length <= MAX_FOCUS_CHARS ? v : null;
}

// Merge LLM-extracted name/role/company with the deterministic email/phone
// candidate values. Drops people the model emitted without any candidate
// ownership (hallucinations from the body).
export function mergePeopleWithCandidates(
  llmPeople: LlmPerson[],
  candidates: Candidate[],
): EnrichedPerson[] {
  const out: EnrichedPerson[] = [];
  for (const p of llmPeople) {
    const person: EnrichedPerson = {
      name: p.name ?? null,
      role: p.role ?? null,
      company: p.company ?? null,
      specialization: focusValue(p.specialization),
      coverage_region: focusValue(p.coverage_region),
      email: null,
      phone: null,
    };
    for (const idx of p.candidate_indices ?? []) {
      if (idx >= 0 && idx < candidates.length) {
        const cand = candidates[idx];
        if (cand.type === 'email') person.email = cand.value;
        else if (cand.type === 'phone') person.phone = cand.value;
      }
    }
    if (person.email || person.phone) out.push(person);
  }
  return out;
}

// Anthropic batch custom_id rules: 1–64 chars, [A-Za-z0-9_-]. Message-IDs
// have angle brackets and `@` so they need sanitizing; long ones get hashed.
export function safeCustomId(messageId: string): string {
  const cleaned = (messageId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  if (cleaned.length >= 1 && cleaned.length <= 64) return cleaned;
  // SHA-256 of original, first 32 hex chars (deterministic, fits in 64).
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return createHash('sha256').update(messageId || '').digest('hex').slice(0, 32);
}

// Stream-read llm_queue.jsonl into memory. Queue is small (≤ a few thousand
// rows) so we just collect them — no need for a streaming consumer here.
export async function readQueue(path: string, limit = 0): Promise<QueueEntry[]> {
  const entries: QueueEntry[] = [];
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    entries.push(JSON.parse(line) as QueueEntry);
    if (limit > 0 && entries.length >= limit) break;
  }
  return entries;
}
