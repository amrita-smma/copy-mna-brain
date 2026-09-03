import { describe, it, expect, vi } from 'vitest';
import { buildVoteSynthesisPrompt, generateVoteSynthesis } from './synthesis';
import { tallyVotes } from './tally';

const tally = tallyVotes(['yes', 'yes', 'hard_yes', 'yes']);

describe('buildVoteSynthesisPrompt', () => {
  it('names the company and the headline result', () => {
    const prompt = buildVoteSynthesisPrompt({
      companyName: 'Project Highway',
      tally,
      ballots: [],
    });

    expect(prompt).toContain('Company: Project Highway');
    expect(prompt).toContain('4–0 FOR');
    expect(prompt).toContain('unanimous');
  });

  it('lists only the choices that were actually cast', () => {
    const prompt = buildVoteSynthesisPrompt({
      companyName: 'Acme',
      tally: tallyVotes(['yes', 'no']),
      ballots: [],
    });

    expect(prompt).toContain('YES 1');
    expect(prompt).toContain('NO 1');
    expect(prompt).not.toContain('HARD YES');
  });

  it('flattens each ballot body to plain text under the voter name', () => {
    const prompt = buildVoteSynthesisPrompt({
      companyName: 'Acme',
      tally,
      ballots: [
        {
          voterName: 'CP Tei',
          choice: 'yes',
          bodyHtml: '<p>Support <strong>signing</strong> the NDA.</p><ul><li>Ulsan permits</li></ul>',
        },
      ],
    });

    expect(prompt).toContain('### CP Tei — YES');
    expect(prompt).toContain('Support signing the NDA.');
    expect(prompt).toContain('- Ulsan permits');
    expect(prompt).not.toContain('<strong>');
  });

  it('marks a ballot with no rationale explicitly', () => {
    const prompt = buildVoteSynthesisPrompt({
      companyName: 'Acme',
      tally,
      ballots: [{ voterName: 'Dessi Sari', choice: 'yes', bodyHtml: null }],
    });

    expect(prompt).toContain('(no rationale written)');
  });

  it('labels a ballot with no choice recorded', () => {
    const prompt = buildVoteSynthesisPrompt({
      companyName: 'Acme',
      tally,
      ballots: [{ voterName: 'Jien Lit', choice: null, bodyHtml: '<p>abstained</p>' }],
    });

    expect(prompt).toContain('NO CHOICE RECORDED');
  });

  it('includes the standing AI Opinion as context only when present', () => {
    const withOpinion = buildVoteSynthesisPrompt({
      companyName: 'Acme',
      tally,
      ballots: [],
      aiOpinionVerdict: 'fail',
      aiOpinionSummary: 'Sub-scale with thin EBITDA.',
    });
    const without = buildVoteSynthesisPrompt({ companyName: 'Acme', tally, ballots: [] });

    expect(withOpinion).toContain('Standing AI Opinion');
    expect(withOpinion).toContain('Sub-scale with thin EBITDA.');
    expect(without).not.toContain('Standing AI Opinion');
  });

  it('says so when nobody cast a ballot', () => {
    const prompt = buildVoteSynthesisPrompt({
      companyName: 'Acme',
      tally: tallyVotes([]),
      ballots: [],
    });

    expect(prompt).toContain('(no ballots were cast)');
    expect(prompt).toContain('no ballots cast');
  });
});

describe('generateVoteSynthesis', () => {
  function makeLlm(response: unknown) {
    const invoke = vi.fn().mockResolvedValue(response);
    return {
      llm: { withStructuredOutput: vi.fn().mockReturnValue({ invoke }) },
      invoke,
    };
  }

  it('returns the trimmed synthesis and bullets from the model', async () => {
    const { llm } = makeLlm({
      synthesis: '  Unanimous 4-0 to proceed.  ',
      key_positives: [' Scarce licensed asset ', 'Linde channel'],
      key_concerns: ['Distressed balance sheet'],
    });

    const result = await generateVoteSynthesis({
      companyName: 'Project Highway',
      tally,
      ballots: [{ voterName: 'CP Tei', choice: 'yes', bodyHtml: '<p>ok</p>' }],
      llmOverride: llm as never,
    });

    expect(result).toEqual({
      synthesis: 'Unanimous 4-0 to proceed.',
      key_positives: ['Scarce licensed asset', 'Linde channel'],
      key_concerns: ['Distressed balance sheet'],
    });
  });

  it('drops bullets that are blank after trimming', async () => {
    const { llm } = makeLlm({
      synthesis: 'Split decision.',
      key_positives: ['Real point', '   ', ''],
      key_concerns: [],
    });

    const result = await generateVoteSynthesis({
      companyName: 'Acme',
      tally,
      ballots: [],
      llmOverride: llm as never,
    });

    expect(result.key_positives).toEqual(['Real point']);
    expect(result.key_concerns).toEqual([]);
  });

  it('propagates a schema failure instead of returning a partial synthesis', async () => {
    const { llm } = makeLlm({ synthesis: 'no bullets at all' });

    await expect(
      generateVoteSynthesis({
        companyName: 'Acme',
        tally,
        ballots: [],
        llmOverride: llm as never,
      }),
    ).rejects.toThrow(/Structured output invocation failed/);
  });
});
