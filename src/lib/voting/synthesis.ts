import { z } from 'zod';
import {
  invokeStructuredOutput,
  type LLMClientOverride,
} from '@/lib/agents/fund_update_processing/structuredOutput';
import { htmlToPlainText } from './html';
import { VOTE_CHOICE_LABELS, type VoteChoice, type VoteTally } from './tally';

export const VOTE_SYNTHESIS_MODEL = 'claude-sonnet-5';

const voteSynthesisSchema = z.object({
  synthesis: z
    .string()
    .describe(
      'One paragraph (60-140 words) summarising where the committee landed and why, naming voters where it clarifies the split.',
    ),
  key_positives: z
    .array(z.string())
    .describe('3-5 short bullets capturing the strongest arguments in favour.'),
  key_concerns: z
    .array(z.string())
    .describe('3-5 short bullets capturing the strongest arguments against.'),
});

export type VoteSynthesis = z.infer<typeof voteSynthesisSchema>;

export interface SynthesisBallotInput {
  voterName: string;
  choice: VoteChoice | null;
  /** The ballot's rationale, still as stored HTML — flattened here. */
  bodyHtml: string | null;
}

export interface VoteSynthesisInput {
  companyName: string;
  tally: VoteTally;
  ballots: SynthesisBallotInput[];
  /** The company's standing AI Opinion, for context (not to be echoed back). */
  aiOpinionVerdict?: string | null;
  aiOpinionSummary?: string | null;
  llmOverride?: LLMClientOverride;
}

const SYSTEM_PROMPT =
  'You are the secretary of an M&A investment committee. You are given the ' +
  'verbatim ballots from a completed vote on one company and must write the ' +
  'minutes: a synthesis paragraph, the key positives, and the key concerns. ' +
  'Work ONLY from the ballots supplied — never introduce facts, numbers or ' +
  'names that are not in them. Write in plain, direct prose with no hedging ' +
  'and no preamble. Quote the reviewers\' own figures and wording where it ' +
  'sharpens the point. Bullets are fragments, not sentences, and each bullet ' +
  'must state one distinct argument. If the ballots are thin, say so plainly ' +
  'and return fewer bullets rather than padding them.';

/** Render the ballots into the prompt body. Exported for prompt-shape tests. */
export function buildVoteSynthesisPrompt(
  input: Omit<VoteSynthesisInput, 'llmOverride'>,
): string {
  const { companyName, tally, ballots } = input;

  const ballotBlocks = ballots.map((ballot) => {
    const choice = ballot.choice ? VOTE_CHOICE_LABELS[ballot.choice] : 'NO CHOICE RECORDED';
    const body = htmlToPlainText(ballot.bodyHtml) || '(no rationale written)';
    return `### ${ballot.voterName} — ${choice}\n${body}`;
  });

  const lines = [
    `Company: ${companyName}`,
    `Result: ${tally.headline} (${tally.outcomeLabel}${tally.unanimous ? ', unanimous' : ''})`,
    `Breakdown: ${Object.entries(tally.counts)
      .filter(([, count]) => count > 0)
      .map(([choice, count]) => `${VOTE_CHOICE_LABELS[choice as VoteChoice]} ${count}`)
      .join(', ') || 'no ballots cast'}`,
  ];

  if (input.aiOpinionVerdict || input.aiOpinionSummary) {
    lines.push(
      '',
      `Standing AI Opinion (context only — do not restate it): ${
        input.aiOpinionVerdict ?? 'n/a'
      } — ${input.aiOpinionSummary ?? 'no summary'}`,
    );
  }

  lines.push(
    '',
    '## Ballots',
    ballotBlocks.length ? ballotBlocks.join('\n\n') : '(no ballots were cast)',
    '',
    'Write the minutes for this vote: a synthesis paragraph, key positives, and key concerns.',
  );

  return lines.join('\n');
}

/**
 * Summarise a concluded vote into the SYNTHESIS / KEY POSITIVES / KEY CONCERNS
 * blocks the results card renders.
 *
 * Called from the `company_vote` conclusion job, never inline in a request —
 * it is a multi-second model call.
 */
export async function generateVoteSynthesis(
  input: VoteSynthesisInput,
): Promise<VoteSynthesis> {
  const result = await invokeStructuredOutput({
    schema: voteSynthesisSchema,
    systemPrompt: SYSTEM_PROMPT,
    prompt: buildVoteSynthesisPrompt(input),
    model: VOTE_SYNTHESIS_MODEL,
    maxTokens: 4000,
    toolName: 'record_vote_minutes',
    llmOverride: input.llmOverride,
  });

  return {
    synthesis: result.synthesis.trim(),
    key_positives: result.key_positives.map((b) => b.trim()).filter(Boolean),
    key_concerns: result.key_concerns.map((b) => b.trim()).filter(Boolean),
  };
}
