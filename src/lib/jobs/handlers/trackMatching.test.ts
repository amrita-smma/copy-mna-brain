import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  findAll: vi.fn(),
  getStatelessAgentGraph: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@/lib/repositories', () => ({
  CompanyRepository: class {
    findById = mocks.findById;
    update = mocks.update;
  },
  InvestmentThesisRepository: class {
    findAll = mocks.findAll;
  },
}));

vi.mock('@/lib/agents/analysis', () => ({
  getStatelessAgentGraph: mocks.getStatelessAgentGraph,
  extractMessageText: (m: { content?: string } | undefined) => m?.content ?? '',
  HumanMessage: class {
    content: string;
    constructor(content: string) {
      this.content = content;
    }
  },
}));

import { runTrackMatching } from './trackMatching';

const TRACKS = [
  { id: 'semi', title: 'Semiconductor', content: 'photoresist, semiconductor, wafer' },
  { id: 'renew', title: 'Renewables', content: 'solar, battery, hydropower' },
];

function aiReply(text: string) {
  return { messages: [{ _getType: () => 'ai', content: text }] };
}

afterEach(() => vi.clearAllMocks());

describe('runTrackMatching', () => {
  it('persists the agent-selected track ids (filtered to known tracks)', async () => {
    mocks.findById.mockResolvedValue({ id: 'c1', target: 'Acme', segment: 'Photoresist', geography: 'KR', project_name: null, thesis_content: null });
    mocks.findAll.mockResolvedValue(TRACKS);
    mocks.getStatelessAgentGraph.mockResolvedValue({ invoke: mocks.invoke });
    mocks.invoke.mockResolvedValue(aiReply('{"trackIds": ["semi", "ghost"]}'));

    const result = await runTrackMatching({ companyId: 'c1' }, { db: {} as never });

    expect(result).toEqual({ companyId: 'c1', matchedTrackIds: ['semi'], via: 'agent' });
    expect(mocks.update).toHaveBeenCalledWith('c1', { matched_track_ids: ['semi'] });
  });

  it('falls back to the keyword heuristic when no agent is available', async () => {
    mocks.findById.mockResolvedValue({ id: 'c2', target: 'SolarCo', segment: 'solar battery systems', geography: 'ID', project_name: null, thesis_content: null });
    mocks.findAll.mockResolvedValue(TRACKS);
    mocks.getStatelessAgentGraph.mockResolvedValue(null);

    const result = await runTrackMatching({ companyId: 'c2' }, { db: {} as never });

    expect(result.via).toBe('heuristic');
    expect(result.matchedTrackIds).toEqual(['renew']);
    expect(mocks.update).toHaveBeenCalledWith('c2', { matched_track_ids: ['renew'] });
  });

  it('falls back to the heuristic when the agent throws', async () => {
    mocks.findById.mockResolvedValue({ id: 'c3', target: 'WaferCo', segment: 'semiconductor wafer', geography: 'TW', project_name: null, thesis_content: null });
    mocks.findAll.mockResolvedValue(TRACKS);
    mocks.getStatelessAgentGraph.mockResolvedValue({ invoke: mocks.invoke });
    mocks.invoke.mockRejectedValue(new Error('LLM down'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runTrackMatching({ companyId: 'c3' }, { db: {} as never });

    expect(result.via).toBe('heuristic');
    expect(result.matchedTrackIds).toEqual(['semi']);
    errSpy.mockRestore();
  });

  it('persists an empty list when there are no tracks', async () => {
    mocks.findById.mockResolvedValue({ id: 'c4', target: 'X', segment: 'whatever', geography: null, project_name: null, thesis_content: null });
    mocks.findAll.mockResolvedValue([]);

    const result = await runTrackMatching({ companyId: 'c4' }, { db: {} as never });

    expect(result).toEqual({ companyId: 'c4', matchedTrackIds: [], via: 'heuristic' });
    expect(mocks.update).toHaveBeenCalledWith('c4', { matched_track_ids: [] });
    expect(mocks.getStatelessAgentGraph).not.toHaveBeenCalled();
  });

  it('treats an empty agent reply as no matches (still via agent)', async () => {
    mocks.findById.mockResolvedValue({ id: 'c5', target: 'Bank', segment: 'retail banking', geography: 'US', project_name: null, thesis_content: null });
    mocks.findAll.mockResolvedValue(TRACKS);
    mocks.getStatelessAgentGraph.mockResolvedValue({ invoke: mocks.invoke });
    mocks.invoke.mockResolvedValue(aiReply('{"trackIds": []}'));

    const result = await runTrackMatching({ companyId: 'c5' }, { db: {} as never });

    expect(result).toEqual({ companyId: 'c5', matchedTrackIds: [], via: 'agent' });
  });
});
