/**
 * How a bot's row reads in the mobile bot list: the latest message as one
 * plain line, and when it was sent. Client safe: pure functions.
 */

/** The latest message's text as one plain line: markdown dropped, yours prefixed. */
export function previewLine(message: { role: 'user' | 'assistant'; text: string } | null): string {
  if (!message) return '';
  const plain = message.text
    .replace(/<[^>]+>/g, ' ') // HTML tags (rare in stored text; drop for previews)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]+)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1') // links → their text, title and all
    .replace(/```[\s\S]*?(```|$)/g, ' ') // fenced code
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '') // headings, quotes, list markers
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, '$1$2') // *em* / _em_, not snake_case
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  return message.role === 'user' ? `You: ${plain}` : plain;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * When the latest message was sent, the way a chat list shows it: the time
 * today, the weekday within the past week, otherwise the date (with the year
 * once it is not this year's).
 */
export function listTimeLabel(iso: string | null, now: Date = new Date(), locale = 'en-US'): string {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const daysAgo = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (daysAgo <= 0) return at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (daysAgo < 7) return at.toLocaleDateString(locale, { weekday: 'long' });
  if (at.getFullYear() === now.getFullYear()) return at.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return at.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}
