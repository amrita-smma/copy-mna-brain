import { describe, expect, it } from 'vitest';
import { pipelineLog, custodianHash } from './pipelineLog';

describe('pipelineLog', () => {
  it('hashes custodians stably', () => {
    expect(custodianHash('a@b.com')).toBe(custodianHash('a@b.com'));
    expect(custodianHash('a@b.com')).not.toBe(custodianHash('c@d.com'));
  });

  it('does not throw when logging safe fields', () => {
    expect(() =>
      pipelineLog('test', 'ok', { run_id: 'x', messages_seen: 1, subject: 'secret' }),
    ).not.toThrow();
  });
});
