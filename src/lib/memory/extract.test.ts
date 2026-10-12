import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), ChatAnthropic: vi.fn() }));

vi.mock('@langchain/anthropic', () => ({ ChatAnthropic: mocks.ChatAnthropic }));

import {
  MAX_FACTS_PER_TURN,
  MAX_FACT_CHARS,
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
  extractUserFacts,
  parseExtractedFacts,
} from './extract';
import { MEMORY_LAYER_BRIEF, MEMORY_LAYER_ROUTING } from './layers';
import { modelSupportsTemperature } from '@/lib/ai/modelParams';

beforeEach(() => {
  vi.clearAllMocks();
  // A function expression, not an arrow: the module calls it with `new`.
  mocks.ChatAnthropic.mockImplementation(function () {
    return { invoke: mocks.invoke };
  });
  mocks.invoke.mockResolvedValue({ content: 'NONE' });
});

describe('MEMORY_EXTRACTION_SYSTEM_PROMPT', () => {
  it('carries the shared five-layer definition rather than paraphrasing it', () => {
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain(MEMORY_LAYER_BRIEF);
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain(MEMORY_LAYER_ROUTING);
  });

  it('makes NONE the expected answer rather than an edge case', () => {
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain('Almost every exchange yields nothing');
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain('never wrong when you are unsure');
  });

  it('rules out the assistant as a source, and rules out inference', () => {
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain('CONTEXT ONLY');
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain(
      'Never write a Memory\nwhose only source is the assistant',
    );
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain('never write one you inferred');
  });

  it('rules out live-deal specifics, which outlive their confidentiality', () => {
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain(
      'Never record a price, valuation, bid',
    );
  });

  it('separates a request for this turn from how the person likes to be answered', () => {
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain('is a request for this turn');
    expect(MEMORY_EXTRACTION_SYSTEM_PROMPT).toContain(
      'how this\n  person likes to be answered',
    );
  });
});

describe('buildExtractionPrompt', () => {
  it('labels the user as the only extractable source', () => {
    const prompt = buildExtractionPrompt('Always answer in Bahasa.', 'Sure, I will.');

    expect(prompt).toContain('USER SAID (the only thing you may extract from):');
    expect(prompt).toContain('Always answer in Bahasa.');
    expect(prompt).toContain('ASSISTANT REPLIED (context only — never a source):');
  });

  it('clips a long assistant reply so an analysis is not a field to mine', () => {
    const prompt = buildExtractionPrompt('q', 'x'.repeat(5_000));

    expect(prompt.length).toBeLessThan(2_400);
    expect(prompt).toContain('…');
  });

  it('keeps a short reply whole so a bare confirmation can be resolved', () => {
    const prompt = buildExtractionPrompt('yes', 'Shall I focus on Indonesian coal?');

    expect(prompt).toContain('Shall I focus on Indonesian coal?');
    expect(prompt).not.toContain('…');
  });

  it('marks an empty side rather than leaving a blank section', () => {
    expect(buildExtractionPrompt('q', '')).toContain('(nothing)');
  });
});

describe('parseExtractedFacts', () => {
  it('returns nothing for the NONE sentinel, in any case', () => {
    expect(parseExtractedFacts('NONE')).toEqual([]);
    expect(parseExtractedFacts('none')).toEqual([]);
    expect(parseExtractedFacts('  None  ')).toEqual([]);
  });

  it('returns nothing for empty or whitespace output', () => {
    expect(parseExtractedFacts('')).toEqual([]);
    expect(parseExtractedFacts('   \n  ')).toEqual([]);
    expect(parseExtractedFacts(null as never)).toEqual([]);
  });

  it('abandons the whole result when NONE appears on its own line', () => {
    // A model that hedged. "Nothing to record" wins over anything beside it.
    expect(parseExtractedFacts('- Covers coal\nNONE')).toEqual([]);
  });

  it('reads one fact per line, stripping the bullet', () => {
    expect(
      parseExtractedFacts('- Covers Indonesian coal and nickel\n- Prefers short answers'),
    ).toEqual(['Covers Indonesian coal and nickel', 'Prefers short answers']);
  });

  it('tolerates numbering, asterisks and quotes', () => {
    expect(parseExtractedFacts('1. Covers coal\n* "Prefers tables"\n2) Reports weekly')).toEqual([
      'Covers coal',
      'Prefers tables',
      'Reports weekly',
    ]);
  });

  it('drops a preamble line the model added instead of answering', () => {
    expect(parseExtractedFacts('Here is what I found:\n- Covers coal')).toEqual([
      'Covers coal',
    ]);
  });

  it('caps how many facts one turn may contribute', () => {
    const many = Array.from(
      { length: 10 },
      (_, i) => `- Covers sector number ${i} for the Jakarta team`,
    ).join('\n');

    expect(parseExtractedFacts(many)).toHaveLength(MAX_FACTS_PER_TURN);
  });

  it('treats every shape of "nothing to store" as nothing', () => {
    // Haiku rarely returns a bare NONE; storing its refusal as a memory about
    // the user is the failure this guards.
    for (const output of [
      'NONE.',
      'None — nothing to store',
      'None (nothing durable in this exchange)',
      'No durable facts about the user here.',
      'Nothing to record.',
      'There are no memorable facts in this exchange.',
      'N/A',
    ]) {
      expect(parseExtractedFacts(output), output).toEqual([]);
    }
  });

  it('drops the model narrating instead of answering', () => {
    expect(parseExtractedFacts('I did not find any durable facts about them.')).toEqual([]);
    expect(parseExtractedFacts('The exchange covers Acme valuation methodology.')).toEqual(
      [],
    );
    expect(parseExtractedFacts('Is the user asking about coal again?')).toEqual([]);
  });

  it('drops a fragment too short to be a self-contained fact', () => {
    expect(parseExtractedFacts('- coal\n- yes')).toEqual([]);
  });

  it('keeps the facts when a preamble sits above them', () => {
    expect(
      parseExtractedFacts('Memories:\n- Covers Indonesian coal and nickel assets'),
    ).toEqual(['Covers Indonesian coal and nickel assets']);
  });

  it('truncates a fact that is really a summary', () => {
    const [fact] = parseExtractedFacts(`- ${'x'.repeat(500)}`);

    expect(fact.length).toBeLessThanOrEqual(MAX_FACT_CHARS + 1);
    expect(fact.endsWith('…')).toBe(true);
  });
});

describe('extractUserFacts', () => {
  it('never sends a temperature the model would reject', async () => {
    // The current Anthropic families 400 on an explicit `temperature`
    // ("`temperature` is deprecated for this model"), which failed every
    // extraction silently until it was caught.
    await extractUserFacts({ userText: 'q', assistantText: 'a', apiKey: 'k' });

    const config = mocks.ChatAnthropic.mock.calls[0][0];
    expect(config.anthropicApiKey).toBe('k');
    expect(modelSupportsTemperature(config.model)).toBe(false);
    expect(config).not.toHaveProperty('temperature');
  });

  it('returns the parsed facts', async () => {
    mocks.invoke.mockResolvedValue({ content: '- Always answers in Bahasa Indonesia' });

    expect(
      await extractUserFacts({ userText: 'q', assistantText: 'a', apiKey: 'k' }),
    ).toEqual(['Always answers in Bahasa Indonesia']);
  });

  it('returns nothing for the ordinary turn', async () => {
    expect(
      await extractUserFacts({
        userText: "What was Acme's FY24 EBITDA?",
        assistantText: 'Acme reported $40m.',
        apiKey: 'k',
      }),
    ).toEqual([]);
  });

  it('does not spend a call on a turn with no user words', async () => {
    expect(
      await extractUserFacts({ userText: '   ', assistantText: 'a', apiKey: 'k' }),
    ).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('sends the system prompt and the labelled exchange', async () => {
    await extractUserFacts({ userText: 'Always use IDR', assistantText: 'Noted', apiKey: 'k' });

    const [system, user] = mocks.invoke.mock.calls[0][0];
    expect(system.content).toBe(MEMORY_EXTRACTION_SYSTEM_PROMPT);
    expect(user.content).toContain('Always use IDR');
    expect(user.content).toContain('context only');
  });
});
