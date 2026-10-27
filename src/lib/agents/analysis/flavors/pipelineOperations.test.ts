import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MNA_PIPELINE_OPERATIONS_GUIDE,
  MNA_PIPELINE_OPERATIONS_SUMMARY,
  PIPELINE_OPERATION_TOPIC_KEYS,
  PIPELINE_OPERATION_TOPICS,
  PIPELINE_OPERATIONS_GUIDE_TOOL,
} from './pipelineOperations';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * The guide used to be one template literal the prompts interpolated. Splitting
 * it into topics for the reader tool must not change a byte of what the model
 * reads when it asks for the whole thing. If you change the guide ON PURPOSE,
 * update this hash in the same commit.
 */
const EXPECTED_GUIDE_HASH = '7fb49d67ffc0b07c015ba330310ab42a356ee1800acdea1cb81b2fbd5d513a37';

describe('MNA_PIPELINE_OPERATIONS_GUIDE', () => {
  it('is the topics joined in prompt order, byte-identical to the single constant it replaced', () => {
    expect(sha256(MNA_PIPELINE_OPERATIONS_GUIDE)).toBe(EXPECTED_GUIDE_HASH);
    expect(MNA_PIPELINE_OPERATIONS_GUIDE).toBe(
      PIPELINE_OPERATION_TOPIC_KEYS.map((key) => PIPELINE_OPERATION_TOPICS[key].body).join('\n\n'),
    );
  });

  it('gives every topic a body that opens with its own heading and a one-line summary', () => {
    for (const key of PIPELINE_OPERATION_TOPIC_KEYS) {
      const section = PIPELINE_OPERATION_TOPICS[key];
      expect(section.body.startsWith(`## ${section.title}\n`), key).toBe(true);
      expect(section.summary.trim(), key).not.toBe('');
      expect(section.summary, key).not.toContain('\n');
    }
  });
});

describe('MNA_PIPELINE_OPERATIONS_SUMMARY', () => {
  it('keeps the routing rules in the prompt and points every topic at the reader tool', () => {
    expect(MNA_PIPELINE_OPERATIONS_SUMMARY).toContain('**You have NO direct write tools.**');
    for (const key of PIPELINE_OPERATION_TOPIC_KEYS) {
      expect(MNA_PIPELINE_OPERATIONS_SUMMARY, key).toContain(`\`${key}\``);
    }
    expect(MNA_PIPELINE_OPERATIONS_SUMMARY).toContain(`\`${PIPELINE_OPERATIONS_GUIDE_TOOL}\``);
    // The navigation guide's exception refers to this section by name, and the
    // answer must not need a tool call.
    expect(MNA_PIPELINE_OPERATIONS_SUMMARY).toContain('Adding a New Company (Chat-Initiated)');
    expect(MNA_PIPELINE_OPERATIONS_SUMMARY).toContain('never with `navigate_page`');
  });

  it('is a fraction of the guide it stands in for', () => {
    expect(MNA_PIPELINE_OPERATIONS_SUMMARY.length).toBeLessThan(MNA_PIPELINE_OPERATIONS_GUIDE.length / 5);
    // And none of the procedures leaked back into the prompt.
    for (const key of PIPELINE_OPERATION_TOPIC_KEYS) {
      expect(MNA_PIPELINE_OPERATIONS_SUMMARY, key).not.toContain(`## ${PIPELINE_OPERATION_TOPICS[key].title}`);
    }
  });
});
