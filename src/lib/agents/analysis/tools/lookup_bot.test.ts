import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: vi.fn(() => ({ botService: { list } })) }));

import { lookupBot } from './lookup_bot';
import { BOT_TOOL_CONFIG, botDto } from '@/lib/bots/testing/botFixtures';

describe('lookup_bot', () => {
  beforeEach(() => list.mockReset());

  it("lists the user's bots with what each does and whether the user may edit it, marking itself", async () => {
    list.mockResolvedValue([
      botDto({ id: 'copilot', name: "Nico's bot", is_default: true, visibility: 'workspace', persona_md: 'Your primary agent.', can_edit: false }),
      botDto(),
      botDto({ id: 'new', name: 'Fresh', persona_md: '', visibility: 'private' }),
    ]);

    const out = (await lookupBot.invoke({}, BOT_TOOL_CONFIG)) as string;

    expect(list).toHaveBeenCalledWith('u1');
    // Brain Bot reaches everyone but is nobody's shared bot.
    expect(out).toContain("| Nico's bot (you) · primary | copilot | Your primary agent. | no | no |");
    expect(out).toContain('| Deal Scout | scout | Find deals. | yes | yes |');
    expect(out).toContain('| Fresh | new | Not set up yet (blank persona) | no | yes |');
  });

  it('ranks the bots whose name or persona fits the query first', async () => {
    list.mockResolvedValue([
      botDto({ id: 'a', name: 'Atlas', persona_md: 'Fund accounting and NAV.' }),
      botDto({ id: 'm', name: 'Miner', persona_md: '## Focus\nCoal **mining** deals in Indonesia.' }),
    ]);

    const out = (await lookupBot.invoke({ query: 'coal mining in Indonesia' }, BOT_TOOL_CONFIG)) as string;

    expect(out.indexOf('| Miner |')).toBeLessThan(out.indexOf('| Atlas |'));
    // Markdown is flattened to one line.
    expect(out).toContain('| Miner | m | Focus Coal mining deals in Indonesia. |');
  });

  it('drops a legacy managed block from what a bot does', async () => {
    list.mockResolvedValue([
      botDto({ persona_md: '<!-- managed:start (x) -->\n# Deal Scout\n<!-- managed:end -->\n\nFind deals.' }),
    ]);

    expect(await lookupBot.invoke({}, BOT_TOOL_CONFIG)).toContain('| Deal Scout | scout | Find deals. |');
  });

  it('refuses to run outside a bot chat', async () => {
    expect(await lookupBot.invoke({}, {})).toContain('only runs inside a Copilot bot chat');
  });
});
