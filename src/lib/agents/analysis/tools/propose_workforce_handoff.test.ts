import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findByNameFuzzy, createDb } = vi.hoisted(() => ({
  findByNameFuzzy: vi.fn(),
  createDb: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb, withBackgroundDb: vi.fn(async (cb) => cb(createDb())) }));

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockCompanyRepository {
    findByNameFuzzy = findByNameFuzzy;
  }
  return {
    ...actual,
    CompanyRepository: MockCompanyRepository,
  };
});

import {
  proposeWorkforceHandoff,
  WORKFORCE_HANDOFF_MARKER,
} from './propose_workforce_handoff';

function extractPayload(result: string) {
  const match = result.match(
    new RegExp(`<!--\\s*${WORKFORCE_HANDOFF_MARKER}:(.*?)-->`, 's'),
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1].trim());
}

describe('proposeWorkforceHandoff', () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    createDb.mockReset().mockReturnValue({});
  });

  afterEach(() => vi.restoreAllMocks());

  it('emits a structured marker the chat UI can parse', async () => {
    const result = (await proposeWorkforceHandoff.invoke({
      title: 'Outbound search + L0/L1 screening + pipeline write',
      rationale:
        'Multi-tool task that modifies pipeline data — better suited to the Workforce queue.',
      instruction:
        'Search Korean CMP slurry suppliers under $500M EV, score against L0/L1, add qualifiers to the pipeline at L0.',
      company_names: [],
    })) as string;

    expect(result).toContain('Workforce handoff proposed');
    expect(result).toContain('Outbound search + L0/L1 screening + pipeline write');

    const payload = extractPayload(result);
    expect(payload).toMatchObject({
      title: 'Outbound search + L0/L1 screening + pipeline write',
      agent_name: 'chat_handoff',
      company_ids: [],
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
      company_names: [],
    })) as string;

    const payload = extractPayload(result);
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
      company_names: [],
    })) as string;

    const payload = extractPayload(result);
    expect(payload.agent_name).toBe('outbound_pipeline_writer');
  });

  it('embeds resolved company_ids from matched names', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({
        id: 'c-acme',
        target: 'Acme Corp',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'c-cinder',
        target: 'Cinder Foods',
        status: 'active',
      });

    const result = (await proposeWorkforceHandoff.invoke({
      title: 'Promote two companies',
      rationale: 'r',
      instruction: 'i',
      company_names: ['Acme', 'Cinder'],
    })) as string;

    const payload = extractPayload(result);
    expect(payload.company_ids).toEqual(['c-acme', 'c-cinder']);
  });

  it('refuses the handoff (no card) when any named company is dropped', async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: 'c-halcyon',
      target: 'Halcyon Media',
      status: 'dropped',
    });

    const result = (await proposeWorkforceHandoff.invoke({
      title: 'Drop Halcyon Media from pipeline',
      rationale: 'r',
      instruction: 'Drop Halcyon Media from the pipeline.',
      company_names: ['Halcyon Media'],
    })) as string;

    expect(result).toMatch(/"Halcyon Media".*dropped and read-only/);
    expect(result).not.toContain(WORKFORCE_HANDOFF_MARKER);
  });

  it('refuses when a mix of dropped and active companies is passed', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({
        id: 'c-acme',
        target: 'Acme Corp',
        status: 'active',
      })
      .mockResolvedValueOnce({
        id: 'c-halcyon',
        target: 'Halcyon Media',
        status: 'dropped',
      });

    const result = (await proposeWorkforceHandoff.invoke({
      title: 'Bulk promote',
      rationale: 'r',
      instruction: 'Promote Acme and Halcyon Media to L1.',
      company_names: ['Acme', 'Halcyon Media'],
    })) as string;

    expect(result).toMatch(/"Halcyon Media"/);
    expect(result).not.toContain(WORKFORCE_HANDOFF_MARKER);
  });

  it('ignores unresolved names (renders card without them)', async () => {
    findByNameFuzzy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'c-acme',
        target: 'Acme Corp',
        status: 'active',
      });

    const result = (await proposeWorkforceHandoff.invoke({
      title: 'Maybe-new outbound target',
      rationale: 'r',
      instruction: 'i',
      company_names: ['NotInPipelineYet', 'Acme'],
    })) as string;

    const payload = extractPayload(result);
    expect(payload.company_ids).toEqual(['c-acme']);
  });
});
