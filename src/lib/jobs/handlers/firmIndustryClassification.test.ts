import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  invokeStructuredOutput: vi.fn(),
  findIndustryEvidence: vi.fn(),
  fillIndustries: vi.fn(),
  releaseIndustryClaims: vi.fn(),
  appendLog: vi.fn(),
}));

vi.mock('@/lib/agents/fund_update_processing/structuredOutput', () => ({
  invokeStructuredOutput: mocks.invokeStructuredOutput,
}));

vi.mock('@/lib/repositories', () => ({
  EmployerRepository: class {
    findIndustryEvidence = mocks.findIndustryEvidence;
    fillIndustries = mocks.fillIndustries;
    releaseIndustryClaims = mocks.releaseIndustryClaims;
  },
  JobRepository: class {
    appendLog = mocks.appendLog;
  },
}));

import {
  FIRM_INDUSTRY_CHUNK,
  buildFirmIndustryPrompt,
  firmIndustryOutputSchema,
  runFirmIndustryClassification,
} from './firmIndustryClassification';

const firm = (id: string, name = `Firm ${id}`) => ({
  id,
  name,
  domains: [`${id}.com`],
  contacts: [{ title: 'Investment Director', specialization: null, bio: null }],
});

const deps = { db: {} as never };

describe('runFirmIndustryClassification', () => {
  beforeEach(() => {
    mocks.invokeStructuredOutput.mockReset();
    mocks.findIndustryEvidence.mockReset();
    mocks.fillIndustries.mockReset().mockImplementation(async (rows: Array<{ id: string }>) =>
      rows.map((r) => r.id),
    );
    mocks.appendLog.mockReset().mockResolvedValue(undefined);
    mocks.releaseIndustryClaims.mockReset().mockResolvedValue(undefined);
  });

  it('writes the label the model picked for each firm ref and skips nulls', async () => {
    mocks.findIndustryEvidence.mockResolvedValue([firm('a'), firm('b')]);
    mocks.invokeStructuredOutput.mockResolvedValue({
      firms: [
        { ref: 'F1', industry: 'Private Credit' },
        { ref: 'F2', industry: null },
      ],
    });

    const out = await runFirmIndustryClassification({ employerIds: ['a', 'b'], workspaceId: 'w1', jobId: 'job-1' }, deps);

    expect(mocks.findIndustryEvidence).toHaveBeenCalledWith('w1', ['a', 'b']);
    expect(mocks.fillIndustries).toHaveBeenCalledWith([{ id: 'a', industry: 'Private Credit' }]);
    expect(out).toEqual({ classified: 1, unresolved: 1, failedChunks: 0 });
    expect(mocks.appendLog).toHaveBeenCalledWith('job-1', {
      message: 'Firm industries labelled',
      metadata: { firms: 2, labelled: 1 },
    });
  });

  it('ignores refs that are not in the chunk and duplicate refs', async () => {
    mocks.findIndustryEvidence.mockResolvedValue([firm('a')]);
    mocks.invokeStructuredOutput.mockResolvedValue({
      firms: [
        { ref: 'F9', industry: 'Legal' },
        { ref: ' F1 ', industry: 'Legal' },
        { ref: 'F1', industry: 'Insurance' },
      ],
    });

    await runFirmIndustryClassification({ employerIds: ['a'], workspaceId: 'w1' }, deps);

    expect(mocks.fillIndustries).toHaveBeenCalledWith([{ id: 'a', industry: 'Legal' }]);
  });

  it('makes one model call per chunk of firms', async () => {
    const firms = Array.from({ length: FIRM_INDUSTRY_CHUNK + 1 }, (_, i) => firm(`f${i}`));
    mocks.findIndustryEvidence.mockResolvedValue(firms);
    mocks.invokeStructuredOutput.mockResolvedValue({ firms: [] });

    await runFirmIndustryClassification({ employerIds: firms.map((f) => f.id), workspaceId: 'w1' }, deps);

    expect(mocks.invokeStructuredOutput).toHaveBeenCalledTimes(2);
  });

  it('keeps the chunks that worked when one model call fails', async () => {
    const firms = Array.from({ length: FIRM_INDUSTRY_CHUNK + 1 }, (_, i) => firm(`f${i}`));
    mocks.findIndustryEvidence.mockResolvedValue(firms);
    mocks.invokeStructuredOutput
      .mockRejectedValueOnce(new Error('overloaded'))
      .mockResolvedValueOnce({ firms: [{ ref: 'F1', industry: 'Legal' }] });

    const out = await runFirmIndustryClassification({ employerIds: firms.map((f) => f.id), workspaceId: 'w1', jobId: 'job-1' }, deps);

    expect(out).toEqual({ classified: 1, unresolved: 0, failedChunks: 1 });
    expect(mocks.fillIndustries).toHaveBeenCalledWith([{ id: `f${FIRM_INDUSTRY_CHUNK}`, industry: 'Legal' }]);
    expect(mocks.appendLog).toHaveBeenCalledWith('job-1', expect.objectContaining({ message: 'overloaded' }));
    expect(mocks.releaseIndustryClaims).toHaveBeenCalledWith(
      firms.slice(0, FIRM_INDUSTRY_CHUNK).map((f) => f.id),
    );
  });

  it('keeps the claim of a firm the model answered null for', async () => {
    mocks.findIndustryEvidence.mockResolvedValue([firm('a')]);
    mocks.invokeStructuredOutput.mockResolvedValue({ firms: [{ ref: 'F1', industry: null }] });

    await runFirmIndustryClassification({ employerIds: ['a'], workspaceId: 'w1' }, deps);

    expect(mocks.releaseIndustryClaims).not.toHaveBeenCalled();
  });

  it('drops an off-list label for that firm only and canonicalizes the rest', async () => {
    mocks.findIndustryEvidence.mockResolvedValue([firm('a'), firm('b')]);
    mocks.invokeStructuredOutput.mockResolvedValue({
      firms: [
        { ref: 'F1', industry: 'Audit and Accounting' },
        { ref: 'F2', industry: 'private equity' },
      ],
    });

    await runFirmIndustryClassification({ employerIds: ['a', 'b'], workspaceId: 'w1' }, deps);

    expect(mocks.fillIndustries).toHaveBeenCalledWith([{ id: 'b', industry: 'Private Equity' }]);
  });

  it('throws when every chunk failed, so the job is marked failed', async () => {
    mocks.findIndustryEvidence.mockResolvedValue([firm('a')]);
    mocks.invokeStructuredOutput.mockRejectedValue(new Error('down'));

    await expect(runFirmIndustryClassification({ employerIds: ['a'], workspaceId: 'w1' }, deps)).rejects.toThrow('down');
    expect(mocks.fillIndustries).not.toHaveBeenCalled();
    expect(mocks.releaseIndustryClaims).toHaveBeenCalledWith(['a']);
  });

  it('does nothing when none of the firms exist any more', async () => {
    mocks.findIndustryEvidence.mockResolvedValue([]);

    const out = await runFirmIndustryClassification({ employerIds: ['gone'], workspaceId: 'w1' }, deps);

    expect(out).toEqual({ classified: 0, unresolved: 0, failedChunks: 0 });
    expect(mocks.invokeStructuredOutput).not.toHaveBeenCalled();
  });
});

describe('firmIndustryOutputSchema', () => {
  it('accepts an off-list label so one bad answer cannot fail the whole chunk', () => {
    expect(
      firmIndustryOutputSchema.safeParse({ firms: [{ ref: 'F1', industry: 'PE firm' }] }).success,
    ).toBe(true);
  });
});

describe('buildFirmIndustryPrompt', () => {
  it('lists each firm with its ref, domains and contact evidence, decoding entities', () => {
    const prompt = buildFirmIndustryPrompt([
      {
        ref: 'F1',
        firm: {
          id: 'a',
          name: 'Kaditapartners',
          domains: ['kaditapartners.com'],
          contacts: [
            { title: 'Investment Associate', specialization: 'Secured private credit', bio: 'A Singapore\n private credit manager &amp; lender.' },
            { title: null, specialization: null, bio: null },
          ],
        },
      },
    ]);
    expect(prompt).toContain('[F1] Kaditapartners');
    expect(prompt).toContain('Domains: kaditapartners.com');
    expect(prompt).toContain(
      'Contact — title: Investment Associate; focus: Secured private credit; bio: A Singapore private credit manager & lender.',
    );
    expect(prompt.match(/Contact —/g)).toHaveLength(1);
    expect(prompt).toContain('Allowed labels: Investment Banking |');
  });
});
