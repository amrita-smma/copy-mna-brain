import { describe, expect, it } from 'vitest';

import {
  proposeWorkforceHandoff,
  WORKFORCE_HANDOFF_MARKER,
} from './propose_workforce_handoff';

describe('proposeWorkforceHandoff', () => {
  it('emits a structured marker the chat UI can parse', async () => {
    const result = (await proposeWorkforceHandoff.invoke({
      title: 'Outbound search + L0/L1 screening + pipeline write',
      rationale:
        'Multi-tool task that modifies pipeline data — better suited to the Workforce queue.',
      instruction:
        'Search Korean CMP slurry suppliers under $500M EV, score against L0/L1, add qualifiers to the pipeline at L0.',
    })) as string;

    expect(result).toContain('Workforce handoff proposed');
    expect(result).toContain('Outbound search + L0/L1 screening + pipeline write');

    const match = result.match(
      new RegExp(`<!--\\s*${WORKFORCE_HANDOFF_MARKER}:(.*?)-->`, 's'),
    );
    expect(match).not.toBeNull();
    const payload = JSON.parse(match![1].trim());
    expect(payload).toMatchObject({
      title: 'Outbound search + L0/L1 screening + pipeline write',
      rationale:
        'Multi-tool task that modifies pipeline data — better suited to the Workforce queue.',
      instruction:
        'Search Korean CMP slurry suppliers under $500M EV, score against L0/L1, add qualifiers to the pipeline at L0.',
      agent_name: 'chat_handoff',
    });
    expect(payload.handoff_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('defaults agent_name to chat_handoff and trims inputs', async () => {
    const result = (await proposeWorkforceHandoff.invoke({
      title: '  Trim me  ',
      rationale: '  rationale  ',
      instruction: '  do the thing  ',
    })) as string;

    const match = result.match(
      new RegExp(`<!--\\s*${WORKFORCE_HANDOFF_MARKER}:(.*?)-->`, 's'),
    );
    const payload = JSON.parse(match![1].trim());
    expect(payload.title).toBe('Trim me');
    expect(payload.rationale).toBe('rationale');
    expect(payload.instruction).toBe('do the thing');
    expect(payload.agent_name).toBe('chat_handoff');
  });

  it('honors an explicit agent_name override', async () => {
    const result = (await proposeWorkforceHandoff.invoke({
      title: 't',
      rationale: 'r',
      instruction: 'i',
      agent_name: 'outbound_pipeline_writer',
    })) as string;

    const match = result.match(
      new RegExp(`<!--\\s*${WORKFORCE_HANDOFF_MARKER}:(.*?)-->`, 's'),
    );
    const payload = JSON.parse(match![1].trim());
    expect(payload.agent_name).toBe('outbound_pipeline_writer');
  });
});
