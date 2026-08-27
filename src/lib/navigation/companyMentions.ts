/**
 * The wire format that lets the chat turn a company *name* in the assistant's
 * prose into a link to that company.
 *
 * The problem: `query_companies` returns a markdown table of names with no ids,
 * so the client has nothing to build a URL from. Rather than guess (or make the
 * client re-query by name), the company-returning tools append a hidden
 * manifest of `{ id, name }` pairs and the client matches those names against
 * the response text.
 *
 * Dependency-free on purpose: written by the tools (server, LangChain) and read
 * by `ChatMessageBubble` (client).
 */

/** HTML comment marker wrapping the JSON manifest in a tool's output. */
export const COMPANY_MENTIONS_MARKER = 'COMPANY_MENTIONS_JSON';

/**
 * The prompt block that makes the chips actually appear, appended to every chat
 * flavor that has company tools (see `src/lib/agents/analysis/index.ts`).
 *
 * It lives here, next to `selectMentionedCompanies`, because the two are one
 * mechanism: the chips are a pure function of how the model writes, and the
 * rules the prompt states ("write the name exactly as returned", "a whole name,
 * not a prefix") are the matcher's rules. Change the matching and this text has
 * to change with it — keeping them in the same file is what makes that obvious.
 *
 * The bias toward naming companies is deliberate and aimed squarely at
 * summaries. "12 deals at L1" is a dead end: no name in the prose means no
 * manifest entry matches, which means no chip and no way for the user to click
 * through to the record. The workforce prompt does NOT get this block — it has
 * no transcript to render chips into.
 */
export const COMPANY_MENTIONS_PROMPT_GUIDE = `
## Naming Companies So The User Can Click Through

Whenever your answer names a company that a tool returned this turn, the chat renders an "Open <name>" button under your message that takes the user straight to that company. The button appears ONLY when the company's name appears in your prose — so how you write decides whether the user can act on your answer or has to go hunting for the record themselves.

**Name the companies. Always. Including in summaries.** A summary is where this matters most and where it is easiest to get wrong. "12 active deals at L1, mostly Japanese industrials" is a dead end. "12 active deals at L1, mostly Japanese industrials — the largest are Acme Chemicals, Toyo Materials and Nippon Fine Products" is the same summary with three places the user can go next. Aggregates, counts, breakdowns, rankings, health checks and recaps should all land on named companies:

- Reporting a count or a share → name the notable members of the cohort (the biggest, the newest, the outliers), not just the number.
- Reporting a breakdown → name an example or two inside the buckets that matter.
- Reporting a ranking or a "top N" → name every company in the list.
- Answering about one company → name it, rather than falling back to "this deal" or "the target".

**Write the name exactly as the tool returned it** (the target or project name from the result table). Chips match the whole name, case-insensitively, on word boundaries — so "Acme Chemicals" links, while "Acme" (a prefix of it) and "the Acme deal" do not. Do not invent, translate, abbreviate, or pluralize a name to make a sentence read better.

**A company can only be chipped if a tool returned it this turn.** \`get_company_stats\` returns aggregates, not rows — a stats-only turn has no companies to link. When your answer is going to reference specific companies, run \`query_companies\` (scoped with the same filters) so the names you use are backed by real records, and use the ids it prints for any follow-on export.

Naming is not a licence to list everything. Fifty chips bury the answer as thoroughly as none. Name the companies your answer is actually about — typically three to ten — and let the table carry the rest.`;

export interface CompanyMention {
  id: string;
  name: string;
}

/** Builds the marker a tool appends to its output. Returns '' for no companies. */
export function buildCompanyMentionsMarker(companies: CompanyMention[]): string {
  const usable = companies.filter((c) => c?.id && c?.name?.trim());
  if (usable.length === 0) return '';
  const payload = usable.map((c) => ({ id: c.id, name: c.name.trim() }));
  return `<!-- ${COMPANY_MENTIONS_MARKER}:${JSON.stringify(payload)} -->`;
}

/** Every well-formed mention in a tool output. Malformed markers are skipped. */
export function parseCompanyMentions(content: string): CompanyMention[] {
  if (!content.includes(COMPANY_MENTIONS_MARKER)) return [];
  const found: CompanyMention[] = [];
  for (const match of content.matchAll(
    new RegExp(`<!--\\s*${COMPANY_MENTIONS_MARKER}:(.*?)-->`, 'gs'),
  )) {
    try {
      const parsed = JSON.parse(match[1]!.trim()) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        const id = (entry as CompanyMention)?.id;
        const name = (entry as CompanyMention)?.name;
        if (typeof id === 'string' && id.trim() && typeof name === 'string' && name.trim()) {
          found.push({ id: id.trim(), name: name.trim() });
        }
      }
    } catch {
      // Ignore — an unparseable manifest just yields no chips.
    }
  }
  return found;
}

/** Strips every manifest so the raw JSON never reaches the rendered transcript. */
export function stripCompanyMentionMarkers(content: string): string {
  return content.replace(
    new RegExp(`\\n*<!--\\s*${COMPANY_MENTIONS_MARKER}:.*?-->`, 'gs'),
    '',
  );
}

/** Escapes a company name for use inside a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The companies the assistant actually named, in the order it named them.
 *
 * This filter is the point of the whole mechanism. A single `query_companies`
 * call can return fifty rows; chipping all of them would bury the answer. Only
 * companies whose name appears in the assistant's own prose get a chip.
 *
 * Matching is case-insensitive and requires a non-word character (or a string
 * boundary) on each side, so "Acme" does not match inside "Acmetric". Names are
 * deduplicated by id, keeping the longest matched name — a company can be
 * referred to by both its target and project name, and the fuller one reads
 * better on a button.
 */
export function selectMentionedCompanies(
  mentions: CompanyMention[],
  responseText: string,
): CompanyMention[] {
  if (mentions.length === 0 || !responseText.trim()) return [];

  const hits: { mention: CompanyMention; at: number }[] = [];
  for (const mention of mentions) {
    const pattern = new RegExp(`(^|[^\\w])${escapeForRegExp(mention.name)}([^\\w]|$)`, 'i');
    const match = pattern.exec(responseText);
    if (match) hits.push({ mention, at: match.index });
  }

  hits.sort((a, b) => a.at - b.at);

  const byId = new Map<string, CompanyMention>();
  for (const { mention } of hits) {
    const existing = byId.get(mention.id);
    if (!existing || mention.name.length > existing.name.length) {
      byId.set(mention.id, mention);
    }
  }
  // Map preserves insertion order, which is first-mention order.
  return [...byId.values()];
}
