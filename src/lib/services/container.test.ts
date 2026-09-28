import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));

import { createContainer } from './container';
import { InsightTemplateRepository } from '@/lib/repositories/insightTemplateRepository';
import { InsightRepository } from '@/lib/repositories/insightRepository';

describe('createContainer', () => {
  it('gives the insight service the workspace template repository for source templates', () => {
    const { insightService } = createContainer({} as never, 'ws-1');
    const templateRepo = (insightService as unknown as { templateRepo: unknown }).templateRepo;

    expect(templateRepo).toBeInstanceOf(InsightTemplateRepository);
    expect((templateRepo as unknown as { workspaceId: string }).workspaceId).toBe('ws-1');
  });

  it('gives the template service the insight repository and workspace for usage counts', () => {
    const { insightTemplateService } = createContainer({} as never, 'ws-1');
    const svc = insightTemplateService as unknown as { insightRepo: unknown; workspaceId: string };

    expect(svc.insightRepo).toBeInstanceOf(InsightRepository);
    expect(svc.workspaceId).toBe('ws-1');
  });
});
