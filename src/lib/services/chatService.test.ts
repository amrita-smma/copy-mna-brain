import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvestmentThesisRepository, CriteriaRepository, Tables } from '@/lib/repositories';
import { ChatService } from './chatService';

type Thesis = Pick<Tables<'investment_thesis'>, 'title' | 'content'>;
type Criteria = Tables<'criterias'>;

function makeThesisRepoStub(): InvestmentThesisRepository {
  return {
    findActiveList: vi.fn(),
    findActive: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  } as unknown as InvestmentThesisRepository;
}

function makeCriteriaRepoStub(): CriteriaRepository {
  return {
    findAll: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as CriteriaRepository;
}

describe('ChatService.buildContext', () => {
  let thesisRepo: InvestmentThesisRepository;
  let criteriaRepo: CriteriaRepository;
  let service: ChatService;

  beforeEach(() => {
    thesisRepo = makeThesisRepoStub();
    criteriaRepo = makeCriteriaRepoStub();
    service = new ChatService(thesisRepo, criteriaRepo);
    vi.mocked(thesisRepo.findActiveList).mockResolvedValue([]);
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([]);
  });

  it('returns empty string when there are no theses and no criteria', async () => {
    const result = await service.buildContext();
    expect(result).toBe('');
  });

  it('includes the thesis section when active theses exist', async () => {
    vi.mocked(thesisRepo.findActiveList).mockResolvedValue([
      { title: 'Growth Equity', content: 'Focus on SaaS companies.' } as Thesis,
    ]);

    const result = await service.buildContext();

    expect(result).toContain('## Current Investment Thesis');
    expect(result).toContain('Growth Equity');
    expect(result).toContain('Focus on SaaS companies.');
  });

  it('includes the criteria section when criteria exist', async () => {
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([
      { id: 'c1', name: 'Revenue', prompt: 'Min $5M ARR', created_at: '', updated_at: '' } as Criteria,
    ]);

    const result = await service.buildContext();

    expect(result).toContain('## Screening Criteria');
    expect(result).toContain('Revenue');
    expect(result).toContain('Min $5M ARR');
  });

  it('numbers multiple criteria sequentially', async () => {
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([
      { id: 'c1', name: 'Revenue', prompt: 'Min $5M ARR', created_at: '', updated_at: '' } as Criteria,
      { id: 'c2', name: 'EBITDA', prompt: 'Min 20% margin', created_at: '', updated_at: '' } as Criteria,
    ]);

    const result = await service.buildContext();

    expect(result).toContain('1. **Revenue**');
    expect(result).toContain('2. **EBITDA**');
  });

  it('includes both sections when both theses and criteria are present', async () => {
    vi.mocked(thesisRepo.findActiveList).mockResolvedValue([
      { title: 'Growth Equity', content: 'Focus on SaaS.' } as Thesis,
    ]);
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([
      { id: 'c1', name: 'Revenue', prompt: 'Min $5M ARR', created_at: '', updated_at: '' } as Criteria,
    ]);

    const result = await service.buildContext();

    expect(result).toContain('## Current Investment Thesis');
    expect(result).toContain('## Screening Criteria');
  });

  it('returns empty string when the repo throws (error is swallowed)', async () => {
    vi.mocked(thesisRepo.findActiveList).mockRejectedValue(new Error('DB error'));

    const result = await service.buildContext();

    expect(result).toBe('');
  });

  it('never injects user information into the system context (personalization travels via runtime config)', async () => {
    const result = await service.buildContext();
    expect(result).not.toContain('User context');
    expect(result).not.toMatch(/@/);
    expect(result).not.toMatch(/email/i);
  });
});
