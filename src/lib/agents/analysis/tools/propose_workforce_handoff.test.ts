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
  handoffAttachments,
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

  describe('attachments', () => {
    const VALID = {
      key: 'chat-attachments/ws-1/file_1.pdf',
      fileName: 'file_1.pdf',
      contentType: 'application/pdf',
    };
    const handoff = async (attachments?: unknown) =>
      extractPayload(
        (await proposeWorkforceHandoff.invoke(
          { title: 'Analyze attached PDF', rationale: 'r', instruction: 'i', company_names: [] },
          attachments === undefined ? undefined : { configurable: { attachments } },
        )) as string,
      );

    it('embeds attachments from runtime configurable in the payload', async () => {
      expect((await handoff([VALID])).attachments).toEqual([VALID]);
    });

    it('drops malformed attachment entries rather than throwing', async () => {
      const payload = await handoff([
        VALID,
        { ...VALID, key: 123 },
        null,
        'just-a-string',
        { key: VALID.key, fileName: 'no-type.pdf' },
      ]);
      expect(payload.attachments).toEqual([VALID]);
    });

    it.each([
      ['no configurable attachments', undefined],
      ['only malformed entries', [{ notAnAttachment: 123 }, null]],
    ])('leaves the attachments key off the payload with %s', async (_label, attachments) => {
      expect(await handoff(attachments)).not.toHaveProperty('attachments');
    });

    describe('fallback to the thread\'s earlier attachments', () => {
      const EARLIER = {
        key: 'chat-attachments/ws-1/brief.html',
        fileName: 'brief.html',
        contentType: 'text/html',
      };
      const handoffWith = async (configurable: Record<string, unknown>) =>
        extractPayload(
          (await proposeWorkforceHandoff.invoke(
            { title: 'Build the insight', rationale: 'r', instruction: 'i', company_names: [] },
            { configurable },
          )) as string,
        );

      it('carries the most recent earlier attachments when this turn has none', async () => {
        const payload = await handoffWith({ attachments: [], priorAttachments: [EARLIER] });
        expect(payload.attachments).toEqual([EARLIER]);
      });

      it("prefers this turn's attachments over earlier ones", async () => {
        const payload = await handoffWith({ attachments: [VALID], priorAttachments: [EARLIER] });
        expect(payload.attachments).toEqual([VALID]);
      });

      it('drops malformed earlier entries, and carries nothing when none are valid', async () => {
        expect((await handoffWith({ priorAttachments: [EARLIER, { key: 1 }] })).attachments).toEqual([EARLIER]);
        expect(await handoffWith({ attachments: [], priorAttachments: [null] })).not.toHaveProperty('attachments');
      });
    });
  });
});

describe('handoffAttachments', () => {
  const REF = { key: 'chat-attachments/ws-1/a.pdf', fileName: 'a.pdf', contentType: 'application/pdf' };

  it('returns undefined with no configurable at all', () => {
    expect(handoffAttachments(undefined)).toBeUndefined();
  });

  it('uses priorAttachments only when the current list is empty or absent', () => {
    expect(handoffAttachments({ priorAttachments: [REF] })).toEqual([REF]);
    expect(handoffAttachments({ attachments: [REF], priorAttachments: [] })).toEqual([REF]);
  });
});

describe('proposeWorkforceHandoff description', () => {
  const description = (proposeWorkforceHandoff as unknown as { description: string })
    .description;

  // "Do NOT use this tool for read-only analysis" made the agent refuse a
  // direct "hand it to workforce" instruction; long research builds are the
  // whole reason Workforce can author insights.
  it('routes work that cannot finish in one turn, read-only included', () => {
    expect(description).not.toMatch(/Do NOT use this tool for read-only analysis/i);
    expect(description).toMatch(/too large to finish in one chat turn/i);
    expect(description).toMatch(/read-only is fine/i);
    // An explicit user instruction must win over the model's own categorisation.
    expect(description).toMatch(/do not argue that the task is read-only/i);
  });
});
