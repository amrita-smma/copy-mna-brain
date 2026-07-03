// Shared logic for the LLM enrichment step. Mirrors mna-mbox-parser/llm_extract.py.
// Pure functions (prompt builder, merge step, schema, system prompt). Anything
// I/O — local Ollama HTTP, Anthropic SDK batch calls — lives in
// crmLlmSubmit / crmLlmFetch job handlers so this module stays testable without network.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { Candidate } from './extract';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QueueEntry {
  message_id: string;
  subject: string;
  sender_email: string;
  domain_tag: string | null;
  payload: {
    body_snippet: string;
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
  candidate_indices: number[];
}

export interface LlmRelatedCompany {
  company_name: string;
  matched_text: string;
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
}

// After merging LLM output back with the deterministic email/phone values.
export interface EnrichedPerson {
  name: string | null;
  role: string | null;
  company: string | null;
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
          candidate_indices: {
            type: 'array',
            items: { type: 'integer', minimum: 0 },
            description:
              'REQUIRED: indices [0, 1, ...] of the input CANDIDATES that belong to this person. If a person has both an email and phone candidate in the same signature, include BOTH indices.',
          },
        },
        required: ['name', 'role', 'company', 'candidate_indices'],
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
          matched_text: { type: 'string', description: 'Brief excerpt from subject/body (≤300 chars).' },
          reason: {
            type: 'string',
            enum: ['explicit_pitch', 'company_mention', 'deal_keyword_context', 'process_reference', 'other'],
          },
          reason_summary: { type: 'string', description: 'One sentence.' },
          keywords: { type: 'array', items: { type: 'string' }, description: '0-8 deal keywords found near the mention.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['company_name', 'matched_text', 'reason', 'reason_summary', 'keywords', 'confidence'],
      },
    },
  },
  required: ['is_personal', 'topics', 'people', 'related_companies'],
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
- Use ONLY what is explicitly in the CONTEXT for name/role/company. If something isn't there, return null. NEVER invent.
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
    {"name": "John Smith", "role": "Managing Director, Industrials Group", "company": "Goldman Sachs", "candidate_indices": [0, 1]},
    {"name": null, "role": null, "company": null, "candidate_indices": [2]}
  ]
}

THING TO CONSIDER:
- sender_email is the email of the sender of the email

TOPIC RULES:
Emit 0-5 topic objects, each with a kebab-case "name" and an "is_deal_related" boolean.
Empty array is fine and better than noise.

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

Output must be valid JSON matching the requested schema.`;

// Build the per-entry user prompt. Order matches the Python version exactly:
// TASK → CANDIDATES → EMAIL BODY, so the model attends to candidates first.
export function buildUserPrompt(entry: QueueEntry): string {
  const { payload } = entry;
  const sections: string[] = [];

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
  sections.push(`TASK:\n${instructions.join('\n')}`);

  if (payload.want_names && payload.candidates.length > 0) {
    const candLines: string[] = [];
    payload.candidates.forEach((c, idx) => {
      candLines.push(`[${idx}] ${c.type.toUpperCase()}: ${c.value}`);
      candLines.push(`    CONTEXT: ${c.context}`);
    });
    sections.push(`CANDIDATES:\n${candLines.join('\n')}`);
  }

  if (entry.subject && (payload.want_topics || payload.want_related_companies)) {
    sections.push(`SUBJECT:\n${entry.subject}`);
  }

  if (payload.want_topics || payload.want_related_companies) {
    // Topics don't need 6000 chars; truncate further for cheaper calls.
    const body = payload.body_snippet.slice(0, 2000);
    sections.push(`EMAIL BODY:\n${body}`);
  }

  return sections.join('\n\n');
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
