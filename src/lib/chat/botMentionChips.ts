/**
 * Bot @mentions drawn as chips. A message that names a bot as `@Name` — the
 * user's, or a bot handing work to another — printed the mention as plain
 * text; the transcript now draws it as that bot's chip.
 *
 * Pure and client-safe.
 */
import { splitBotMentions, type MentionableBot } from '@/lib/bots/mentions';

/** The hast property a mention `<span>` carries the bot's id in. */
export const BOT_MENTION_PROP = 'dataBotMention';

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** Where `@Name` is not prose: a link's text is the link, and code is literal. */
const SKIP = new Set(['link', 'linkReference', 'code', 'inlineCode', 'html']);

function mentionNodes(node: MdNode, bots: readonly MentionableBot[]): MdNode[] {
  const segments = splitBotMentions(node.value ?? '', bots);
  if (!segments.some((s) => s.bot)) return [node];
  return segments.map((s) =>
    s.bot
      ? {
          type: 'botMention',
          data: { hName: 'span', hProperties: { [BOT_MENTION_PROP]: s.bot.id } },
          children: [{ type: 'text', value: s.text }],
        }
      : { type: 'text', value: s.text },
  );
}

function walk(parent: MdNode, bots: readonly MentionableBot[]): void {
  if (!parent.children) return;
  parent.children = parent.children.flatMap((child) => {
    if (child.type === 'text') return mentionNodes(child, bots);
    if (!SKIP.has(child.type)) walk(child, bots);
    return [child];
  });
}

/**
 * Remark plugin: each `@Name` of one of `bots` in prose becomes a `<span>`
 * carrying the bot's id under `BOT_MENTION_PROP`, which the transcript draws
 * as the bot's chip. Matching is `findBotMentions`'s, so a chip appears on
 * exactly the text the server reads as a mention.
 */
export function remarkBotMentions(options: { bots: readonly MentionableBot[] }) {
  return (tree: MdNode) => {
    if (options.bots.length > 0) walk(tree, options.bots);
  };
}
