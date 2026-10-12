import { describe, it, expect, vi } from 'vitest';
import { proposeMemories, readMemoryImportContext } from './propose_memories';

describe('readMemoryImportContext', () => {
  it('reads the collector and origin, ignoring values of the wrong shape', () => {
    const collector: string[] = [];
    expect(readMemoryImportContext({ memory_proposal: collector, memory_origin: 'ChatGPT' })).toEqual(
      { memory_proposal: collector, memory_origin: 'ChatGPT' },
    );
    expect(readMemoryImportContext({ memory_proposal: 'nope', memory_origin: 42 })).toEqual({
      memory_proposal: undefined,
      memory_origin: undefined,
    });
    expect(readMemoryImportContext(undefined)).toEqual({
      memory_proposal: undefined,
      memory_origin: undefined,
    });
  });
});

describe('propose_memories', () => {
  it('collects into the run’s array rather than returning the list to the model', async () => {
    // A tool's return value goes to the model, not to us — parsing the agent's
    // prose for a list is the fragility this avoids.
    const collector: string[] = [];

    const result = await proposeMemories.invoke(
      { memories: ['Covers Indonesian coal', 'Prefers short answers'] },
      { configurable: { memory_proposal: collector } },
    );

    expect(collector).toEqual(['Covers Indonesian coal', 'Prefers short answers']);
    expect(result).toContain('Proposed 2 memories');
    expect(result).toContain('not saved yet');
  });

  it('appends, so a second call does not discard the first batch', async () => {
    const collector: string[] = ['already here'];

    await proposeMemories.invoke(
      { memories: ['and this' ] },
      { configurable: { memory_proposal: collector } },
    );

    expect(collector).toEqual(['already here', 'and this']);
  });

  it('reports an empty extraction without touching the collector', async () => {
    const collector: string[] = [];

    const result = await proposeMemories.invoke(
      { memories: [] },
      { configurable: { memory_proposal: collector } },
    );

    expect(collector).toEqual([]);
    expect(result).toContain('Nothing durable');
  });

  it('refuses when the run has nowhere to put the proposals', async () => {
    const result = await proposeMemories.invoke({ memories: ['a'] }, { configurable: {} });

    expect(result).toContain('nowhere to put');
  });

  it('uses the singular for one memory', async () => {
    const result = await proposeMemories.invoke(
      { memories: ['Covers coal'] },
      { configurable: { memory_proposal: [] } },
    );

    expect(result).toContain('Proposed 1 memory ');
  });

  it('rejects an entry longer than one statement should ever be', async () => {
    await expect(
      proposeMemories.invoke(
        { memories: ['x'.repeat(501)] },
        { configurable: { memory_proposal: [] } },
      ),
    ).rejects.toThrow();
  });

  it('never writes anything itself', async () => {
    // The tool has no store to reach; this pins that it stays that way.
    const spy = vi.fn();
    await proposeMemories.invoke(
      { memories: ['a'] },
      { configurable: { memory_proposal: [], save: spy } },
    );
    expect(spy).not.toHaveBeenCalled();
  });
});
