import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { BOT_FIXED_INSTRUCTIONS, BOT_GUARDRAILS, BOT_REPLY_STYLE, assembleBotSystemPrompt } from './prompt';
import { STALE_SOURCE_MONTHS } from '@/lib/chat/citations';
import { BOT_SKILL_KEYS, BOT_SKILL_META } from './types';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const FLAVOR = 'FLAVOR PROMPT';

describe('assembleBotSystemPrompt', () => {
  it('orders the guardrails, the flavor, the reply style, the fixed instructions, then who the bot is', () => {
    const prompt = assembleBotSystemPrompt(FLAVOR, { name: 'Scout', persona_md: 'Be brief.' });

    const at = (s: string) => prompt.indexOf(s);
    expect(at(BOT_GUARDRAILS)).toBe(0);
    expect(at(FLAVOR)).toBeGreaterThan(at(BOT_GUARDRAILS));
    expect(at(BOT_REPLY_STYLE)).toBeGreaterThan(at(FLAVOR));
    expect(at(BOT_FIXED_INSTRUCTIONS)).toBeGreaterThan(at(BOT_REPLY_STYLE));
    expect(at('Your name is Scout.')).toBeGreaterThan(at(BOT_FIXED_INSTRUCTIONS));
    expect(prompt.endsWith('<bot_persona>\nBe brief.\n</bot_persona>')).toBe(true);
  });

  it('tells every bot how to use every skill, whatever its persona', () => {
    for (const key of BOT_SKILL_KEYS) expect(BOT_FIXED_INSTRUCTIONS).toContain(BOT_SKILL_META[key].guide);
    expect(BOT_FIXED_INSTRUCTIONS).toContain('nobody can change this part');
  });

  it('tells every bot to call lookup_bot before every hand-off to another bot', () => {
    expect(BOT_FIXED_INSTRUCTIONS).toContain('**Before every hand-off, call lookup_bot first**');
    expect(BOT_FIXED_INSTRUCTIONS).toContain('@mention of its exact name');
  });

  it('has a bot with a blank persona ask who it is and save the answer with update_bot', () => {
    const prompt = assembleBotSystemPrompt(FLAVOR, { name: 'Fresh', persona_md: '  ' });

    expect(prompt).toContain('Your persona is blank');
    expect(prompt).toContain('update_bot on yourself (bot: "Fresh"');
    expect(prompt).not.toContain('<bot_persona>');
  });

  it('tells every bot apart a persona change (everyone) from a note to remember (this user)', () => {
    expect(BOT_FIXED_INSTRUCTIONS).toContain('### Persona or memory: two different changes');
    expect(BOT_FIXED_INSTRUCTIONS).toContain('update_bot with persona or persona_append');
    expect(BOT_FIXED_INSTRUCTIONS).toContain('update_bot with remember');
    expect(BOT_FIXED_INSTRUCTIONS).toContain('on a shared bot the user confirms it on a card first');
    expect(BOT_FIXED_INSTRUCTIONS).not.toContain('propose_update_bot');
  });

  it('drops a legacy managed block from a stored persona', () => {
    const stored = '<!-- managed:start (x) -->\n# Old name\n<!-- managed:end -->\n\nBe brief.';
    const prompt = assembleBotSystemPrompt(FLAVOR, { name: 'New name', persona_md: stored });
    expect(prompt).toContain('Your name is New name.');
    expect(prompt).not.toContain('Old name');
    expect(prompt).toContain('<bot_persona>\nBe brief.\n</bot_persona>');
  });

  it('tells every bot to lead with the verdict, stay brief without researching less, cite dated sources inline, and offer choices as cards', () => {
    expect(BOT_REPLY_STYLE).toContain('**Verdict first.**');
    expect(BOT_REPLY_STYLE).toContain('Brevity changes how you write, not how much you check');
    expect(BOT_REPLY_STYLE).toContain('([Reuters, 12 Mar 2026](https://…))');
    expect(BOT_REPLY_STYLE).toContain(`older than ${STALE_SOURCE_MONTHS} months`);
    expect(BOT_REPLY_STYLE).toContain('call offer_options');
    expect(BOT_REPLY_STYLE).toContain('Offering your own next action');
    expect(BOT_REPLY_STYLE).toContain('not a choice card');
  });

  // Pinned like promptStability.test.ts pins the flavor prompts: a change to
  // the guardrails or the assembly must be deliberate. Update the hash in the
  // same commit when it is.
  it('keeps the guardrails and a new bot\'s assembly byte-stable', () => {
    expect(sha256(BOT_GUARDRAILS)).toBe(GUARDRAILS_HASH);
    expect(sha256(assembleBotSystemPrompt(FLAVOR, { name: 'Copilot', persona_md: '' }))).toBe(NEW_BOT_HASH);
  });
});

const GUARDRAILS_HASH = 'd016d2a0590f3924b2c399dd92eff324b6f63ea0b00e3790cf7b13abc5ff6e66';
const NEW_BOT_HASH = '9e966d7aa9ed537530bf0cfd8ac87f33254fed37c3a19ccc8dbfb4714e38d3e0';
