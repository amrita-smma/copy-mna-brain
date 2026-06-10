import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnableConfig } from '@langchain/core/runnables';

const { notifyTaskInsight } = vi.hoisted(() => ({
  notifyTaskInsight: vi.fn(),
}));

vi.mock('@/lib/services/emailNotificationService', () => {
  class MockNotificationService {
    notifyTaskInsight = notifyTaskInsight;
  }
  return { EmailNotificationService: MockNotificationService };
});

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/repositories', () => ({
  AiWorkforceQueueRepository: class {},
  RoutinesRepository: class {},
  UserRepository: class {},
}));

import { flagInsight } from './flag_insight';

function invoke(args: Record<string, unknown>, config: RunnableConfig | undefined) {
  return flagInsight.invoke(args, config);
}

describe('flag_insight', () => {
  beforeEach(() => notifyTaskInsight.mockReset());

  it('skips when there is no run context (thread_id)', async () => {
    const result = await invoke(
      { company_name: 'NovaSpec', level: 'L1' },
      { configurable: {} },
    );
    expect(String(result)).toMatch(/No run context/);
    expect(notifyTaskInsight).not.toHaveBeenCalled();
  });

  it('forwards the insight to EmailNotificationService keyed by thread_id', async () => {
    notifyTaskInsight.mockResolvedValue(true);
    const result = await invoke(
      { company_name: 'NovaSpec Materials', level: 'L1', confidence_pct: 94, detail: 'strong comps' },
      { configurable: { thread_id: 'run-7' } },
    );
    expect(notifyTaskInsight).toHaveBeenCalledWith('run-7', {
      companyName: 'NovaSpec Materials',
      level: 'L1',
      detail: 'strong comps',
      confidencePct: 94,
    });
    expect(String(result)).toMatch(/NovaSpec Materials passes L1/);
  });

  it('reports when nothing was sent', async () => {
    notifyTaskInsight.mockResolvedValue(false);
    const result = await invoke(
      { company_name: 'X', level: 'L2' },
      { configurable: { thread_id: 'run-7' } },
    );
    expect(String(result)).toMatch(/not sent/i);
  });
});
