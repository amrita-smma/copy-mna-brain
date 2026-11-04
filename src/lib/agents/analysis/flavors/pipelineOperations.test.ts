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
 * The guide used to be one template literal the prompts interpolated; the
 * topics the reader tool serves must join back into exactly the text the model
 * reads when it asks for the whole thing. If you change the guide ON PURPOSE,
 * update this hash in the same commit. Last change: the `send_email` topic
 * sets `send_as_brain: true` on "email me", so a self-addressed email is sent
 * from Investment Brain instead of drafted in the user's own Gmail.
 */
const EXPECTED_GUIDE_HASH = '5c5380f789d797e2f78b0a8f23a507056815fcf8962d359f8adb4d36d45ab50a';

describe('MNA_PIPELINE_OPERATIONS_GUIDE', () => {
  it('is the topics joined in prompt order, pinned byte for byte', () => {
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

describe('promote_l0_l1', () => {
  const body = PIPELINE_OPERATION_TOPICS.promote_l0_l1.body;

  it('puts the EBITDA assessment in the reply after the handoff card, banner first', () => {
    // Steps in order: read, confirm L0, assess, hand off, then the visible reply.
    const handoff = body.indexOf('4. Call `propose_workforce_handoff`');
    const reply = body.indexOf('5. **Your reply after the card is the assessment');
    expect(handoff).toBeGreaterThan(0);
    expect(reply).toBeGreaterThan(handoff);
    expect(body).toMatch(/never only in your thinking/);
    expect(body).toMatch(/it is the first thing in your reply, before any other sentence/);
    // The format is shown, not just described, and the caveat in the
    // instruction is explicitly not a substitute for the banner.
    expect(body).toContain('<!-- WARNING_START -->\nEBITDA was -$2M in FY2024 on $30M revenue (negative margin).\n<!-- WARNING_END -->');
    expect(body).toMatch(/Writing the caveat into the handoff instruction is not a substitute/);
    expect(PIPELINE_OPERATION_TOPICS.promote_l0_l1.summary).toMatch(/the handoff, then the warning block first in your reply/);
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
