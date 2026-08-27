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
