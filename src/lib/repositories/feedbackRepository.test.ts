import { describe, it, expect, vi, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { feedback } from '@/lib/db/schema';
import { FeedbackRepository } from './feedbackRepository';

const insertChain = {
  values: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn(),
};

const mockDb = {
  insert: vi.fn().mockReturnValue(insertChain),
  update: vi.fn().mockReturnValue(updateChain),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.insert.mockReturnValue(insertChain);
  mockDb.update.mockReturnValue(updateChain);
  insertChain.values.mockReturnThis();
  updateChain.set.mockReturnThis();
}

describe('FeedbackRepository.create', () => {
  let repo: FeedbackRepository;

  beforeEach(() => {
    resetDb();
    repo = new FeedbackRepository(mockDb as never, 'workspace-1');
  });

  it('inserts a feedback row scoped to the repo workspace', async () => {
    const row = {
      id: 'f1',
      workspace_id: 'workspace-1',
      user_id: 'user-1',
      title: 'Dark mode',
      message: 'Please add dark mode',
      jira_issue_key: null,
      created_at: '2026-08-03T00:00:00.000Z',
    };
    insertChain.returning.mockResolvedValueOnce([row]);

    const result = await repo.create({
      userId: 'user-1',
      title: 'Dark mode',
      message: 'Please add dark mode',
    });

    expect(insertChain.values).toHaveBeenCalledWith({
      workspace_id: 'workspace-1',
      user_id: 'user-1',
      title: 'Dark mode',
      message: 'Please add dark mode',
    });
    expect(result).toEqual(row);
  });
});

describe('FeedbackRepository.setJiraIssueKey', () => {
  let repo: FeedbackRepository;

  beforeEach(() => {
    resetDb();
    repo = new FeedbackRepository(mockDb as never, 'workspace-1');
  });

  it('updates the row with the given Jira issue key, scoped to the repo workspace', async () => {
    updateChain.where.mockResolvedValueOnce(undefined);

    await repo.setJiraIssueKey('f1', 'MB-999');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith({ jira_issue_key: 'MB-999' });
    expect(updateChain.where).toHaveBeenCalledTimes(1);
    // The filter must scope by both the row id and the repo's workspace_id.
    expect(updateChain.where).toHaveBeenCalledWith(
      and(eq(feedback.id, 'f1'), eq(feedback.workspace_id, 'workspace-1')),
    );
  });
});
