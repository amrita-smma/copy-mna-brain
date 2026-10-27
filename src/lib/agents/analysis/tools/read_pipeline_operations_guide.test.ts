import { describe, expect, it } from 'vitest';
import { readPipelineOperationsGuide } from './read_pipeline_operations_guide';
import {
  MNA_PIPELINE_OPERATIONS_GUIDE,
  PIPELINE_OPERATION_TOPIC_KEYS,
  PIPELINE_OPERATION_TOPICS,
} from '../flavors/pipelineOperations';

describe('read_pipeline_operations_guide', () => {
  it('returns exactly one topic\'s procedure, heading included', async () => {
    for (const key of PIPELINE_OPERATION_TOPIC_KEYS) {
      const out = (await readPipelineOperationsGuide.invoke({ topic: key })) as string;
      expect(out, key).toBe(PIPELINE_OPERATION_TOPICS[key].body);
      expect(out.startsWith('## '), key).toBe(true);
    }
  });

  it('returns the whole guide for "all"', async () => {
    expect(await readPipelineOperationsGuide.invoke({ topic: 'all' })).toBe(MNA_PIPELINE_OPERATIONS_GUIDE);
  });

  it('rejects a topic it does not know rather than guessing', async () => {
    await expect(readPipelineOperationsGuide.invoke({ topic: 'emails' } as never)).rejects.toThrow();
  });

  it('names every topic in its description so the model can pick one without reading the guide', () => {
    expect(readPipelineOperationsGuide.name).toBe('read_pipeline_operations_guide');
    for (const key of PIPELINE_OPERATION_TOPIC_KEYS) {
      expect(readPipelineOperationsGuide.description, key).toContain(`${key} — `);
    }
  });
});
