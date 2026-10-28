import { describe, it, expect } from 'vitest';
import { remarkBotMentions, BOT_MENTION_PROP } from './botMentionChips';

const bots = [
  { id: 'deal', name: 'Deal' },
  { id: 'scout', name: 'Deal Scout' },
];

type Node = { type: string; value?: string; children?: Node[]; data?: Record<string, unknown> };

const text = (value: string): Node => ({ type: 'text', value });
const run = (tree: Node, list = bots) => {
  remarkBotMentions({ bots: list })(tree);
  return tree;
};

describe('remarkBotMentions', () => {
  it("turns a bot's @Name in prose into a span carrying the bot's id", () => {
    const tree = run({ type: 'root', children: [{ type: 'paragraph', children: [text('Asking @Deal Scout now.')] }] });
    expect(tree.children?.[0].children).toEqual([
      text('Asking '),
      {
        type: 'botMention',
        data: { hName: 'span', hProperties: { [BOT_MENTION_PROP]: 'scout' } },
        children: [text('@Deal Scout')],
      },
      text(' now.'),
    ]);
  });

  it('reaches mentions nested in emphasis and list items', () => {
    const tree = run({
      type: 'root',
      children: [{ type: 'list', children: [{ type: 'listItem', children: [{ type: 'strong', children: [text('@Deal')] }] }] }],
    });
    const strong = tree.children?.[0].children?.[0].children?.[0];
    expect(strong?.children?.[0].type).toBe('botMention');
  });

  it('leaves link text and code alone', () => {
    const link: Node = { type: 'link', children: [text('@Deal')] };
    const inline: Node = { type: 'inlineCode', value: '@Deal' };
    const tree = run({ type: 'root', children: [{ type: 'paragraph', children: [link, inline] }] });
    expect(tree.children?.[0].children).toEqual([{ type: 'link', children: [text('@Deal')] }, inline]);
  });

  it('changes nothing when there are no bots or no mentions', () => {
    const para = (): Node => ({ type: 'root', children: [{ type: 'paragraph', children: [text('Hi @Deal')] }] });
    expect(run(para(), [])).toEqual(para());
    const plain: Node = { type: 'root', children: [{ type: 'paragraph', children: [text('mail a@Deal.com')] }] };
    expect(run(structuredClone(plain))).toEqual(plain);
  });
});
