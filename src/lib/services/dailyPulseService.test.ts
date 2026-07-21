import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DailyPulseService,
  formatDateLabel,
  utcDay,
} from './dailyPulseService';
import type { DailyPulseGenerator } from '@/lib/dashboard/dailyPulseNarrator';

describe('date helpers', () => {
  it('utcDay and formatDateLabel format a date in UTC', () => {
    const d = new Date('2026-07-20T09:30:00Z');
    expect(utcDay(d)).toBe('2026-07-20');
    expect(formatDateLabel(d)).toBe('Jul 20, 2026');
  });
});

function makeService(overrides?: {
  generate?: DailyPulseGenerator;
  cacheGet?: ReturnType<typeof vi.fn>;
  cacheSet?: ReturnType<typeof vi.fn>;
}) {
  const cacheGet = overrides?.cacheGet ?? vi.fn().mockResolvedValue(null);
  const cacheSet = overrides?.cacheSet ?? vi.fn().mockResolvedValue(undefined);
  const pulseRepo = { findByDate: cacheGet, upsert: cacheSet };
  const generate =
    overrides?.generate ?? vi.fn().mockResolvedValue('# Recap\nAll good.');

  const service = new DailyPulseService('ws-1', pulseRepo as never, generate);
  return { service, cacheGet, cacheSet, generate };
}

describe('DailyPulseService.getPulse', () => {
  const now = new Date('2026-07-20T12:00:00Z');

  afterEach(() => vi.clearAllMocks());

  it("returns today's stored pulse without generating", async () => {
    const cachedPulse = { date: '2026-07-20', content: 'cached' };
    const { service, generate, cacheSet, cacheGet } = makeService({
      cacheGet: vi.fn().mockResolvedValue(cachedPulse),
    });

    const result = await service.getPulse({ now });

    expect(result).toBe(cachedPulse);
    expect(cacheGet).toHaveBeenCalledWith('2026-07-20');
    expect(generate).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it('returns null on a miss and never triggers generation', async () => {
    const { service, generate, cacheSet } = makeService({
      cacheGet: vi.fn().mockResolvedValue(null),
    });

    const result = await service.getPulse({ now });

    expect(result).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });
});

describe('DailyPulseService.generatePulse', () => {
  const now = new Date('2026-07-20T12:00:00Z');

  afterEach(() => vi.clearAllMocks());

  it('generates via the Analyst agent and upserts, ignoring any cached row', async () => {
    const generate = vi.fn().mockResolvedValue('# Today\nQuiet day.');
    const cacheGet = vi.fn().mockResolvedValue({ date: '2026-07-20', content: 'cached' });
    const { service, cacheSet } = makeService({ generate, cacheGet });

    const result = await service.generatePulse({ now });

    expect(cacheGet).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledWith(now, 'ws-1');
    expect(result).toEqual({
      date: '2026-07-20',
      dateLabel: 'Jul 20, 2026',
      content: '# Today\nQuiet day.',
      generatedAt: now.toISOString(),
    });
    expect(cacheSet).toHaveBeenCalledWith('2026-07-20', result);
  });

  it('propagates a generation failure and caches nothing', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('agent down'));
    const { service, cacheSet } = makeService({ generate });

    await expect(service.generatePulse({ now })).rejects.toThrow('agent down');
    expect(cacheSet).not.toHaveBeenCalled();
  });
});
