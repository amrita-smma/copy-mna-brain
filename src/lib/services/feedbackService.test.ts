import { describe, it, expect, vi, beforeEach } from 'vitest';

const { isJiraConfigured, createJiraIssue } = vi.hoisted(() => ({
  isJiraConfigured: vi.fn(),
  createJiraIssue: vi.fn(),
}));

vi.mock('@/lib/jira', () => ({ isJiraConfigured, createJiraIssue }));

import { FeedbackService } from './feedbackService';

function makeDeps() {
  const feedbackRepo = {
    create: vi.fn(),
    setJiraIssueKey: vi.fn(),
  };
  const userRepo = { findById: vi.fn() };
  const workspaceRepo = { findById: vi.fn() };
  const emailService = { sendFeedbackSubmittedEmail: vi.fn() };
  return { feedbackRepo, userRepo, workspaceRepo, emailService };
}

const ROW = {
  id: 'f1',
  workspace_id: 'w1',
  user_id: 'u1',
  title: 'Dark mode',
  message: 'Please add dark mode',
  jira_issue_key: null,
  created_at: '2026-08-03T00:00:00.000Z',
};

const SUBMIT = {
  userId: 'u1',
  title: 'Dark mode',
  message: 'Please add dark mode',
};

describe('FeedbackService.submit', () => {
  let deps: ReturnType<typeof makeDeps>;
  let service: FeedbackService;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
    deps.userRepo.findById.mockResolvedValue({ id: 'u1', name: 'Jane Doe', email: 'jane@sqe.co.id' });
    deps.workspaceRepo.findById.mockResolvedValue({ id: 'w1', name: 'SQE Capital' });
    deps.feedbackRepo.create.mockResolvedValue(ROW);
    isJiraConfigured.mockReturnValue(false);
    service = new FeedbackService(
      deps.feedbackRepo as never,
      deps.userRepo as never,
      deps.workspaceRepo as never,
      'w1',
      deps.emailService as never,
    );
  });

  it('throws when title is blank', async () => {
    await expect(service.submit({ ...SUBMIT, title: '   ' })).rejects.toThrow(/title is required/);
    expect(deps.feedbackRepo.create).not.toHaveBeenCalled();
  });

  it('throws when message is blank', async () => {
    await expect(service.submit({ ...SUBMIT, message: '   ' })).rejects.toThrow(
      /message is required/,
    );
    expect(deps.feedbackRepo.create).not.toHaveBeenCalled();
  });

  it('stores the trimmed title and message scoped to the submitting user + workspace', async () => {
    await service.submit({
      userId: 'u1',
      title: '  Dark mode  ',
      message: '  Please add dark mode  ',
    });

    expect(deps.feedbackRepo.create).toHaveBeenCalledWith({
      userId: 'u1',
      title: 'Dark mode',
      message: 'Please add dark mode',
    });
  });

  it('collapses newlines in the title before storing', async () => {
    await service.submit({
      userId: 'u1',
      title: 'Dark\nmode\r\nplease',
      message: 'Please add dark mode',
    });

    expect(deps.feedbackRepo.create).toHaveBeenCalledWith({
      userId: 'u1',
      title: 'Dark mode please',
      message: 'Please add dark mode',
    });
  });

  it('throws when title exceeds the 200-character cap', async () => {
    await expect(service.submit({ ...SUBMIT, title: 'x'.repeat(201) })).rejects.toThrow(/200/);
    expect(deps.feedbackRepo.create).not.toHaveBeenCalled();
  });

  it('accepts a title at exactly the 200-character cap', async () => {
    await service.submit({ ...SUBMIT, title: 'x'.repeat(200) });

    expect(deps.feedbackRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'x'.repeat(200) }),
    );
  });

  it('throws when message exceeds the 5000-character cap', async () => {
    await expect(service.submit({ ...SUBMIT, message: 'x'.repeat(5001) })).rejects.toThrow(/5000/);
    expect(deps.feedbackRepo.create).not.toHaveBeenCalled();
  });

  it('emails nico.alimin@smma.id with the submitter and workspace details', async () => {
    await service.submit(SUBMIT);

    expect(deps.emailService.sendFeedbackSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'nico.alimin@smma.id',
        submitterName: 'Jane Doe',
        submitterEmail: 'jane@sqe.co.id',
        workspaceName: 'SQE Capital',
        title: 'Dark mode',
        message: 'Please add dark mode',
      }),
    );
  });

  it('skips Jira when it is not configured, but still saves and emails', async () => {
    const result = await service.submit(SUBMIT);

    expect(createJiraIssue).not.toHaveBeenCalled();
    expect(deps.feedbackRepo.setJiraIssueKey).not.toHaveBeenCalled();
    expect(deps.emailService.sendFeedbackSubmittedEmail).toHaveBeenCalled();
    expect(result).toEqual(ROW);
  });

  it('files a Jira ticket and stamps the key back when Jira is configured', async () => {
    isJiraConfigured.mockReturnValue(true);
    createJiraIssue.mockResolvedValue({
      key: 'MB-999',
      url: 'https://smma-sqe.atlassian.net/browse/MB-999',
    });

    const result = await service.submit(SUBMIT);

    expect(createJiraIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Dark mode',
        description: expect.stringContaining('Please add dark mode'),
      }),
    );
    expect(deps.feedbackRepo.setJiraIssueKey).toHaveBeenCalledWith('f1', 'MB-999');
    expect(deps.emailService.sendFeedbackSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ jiraIssueKey: 'MB-999', jiraIssueUrl: expect.stringContaining('MB-999') }),
    );
    expect(result).toEqual({ ...ROW, jira_issue_key: 'MB-999' });
  });

  it('omits the Jira key from the API response when stamping fails, but still emails the link', async () => {
    isJiraConfigured.mockReturnValue(true);
    createJiraIssue.mockResolvedValue({
      key: 'MB-999',
      url: 'https://smma-sqe.atlassian.net/browse/MB-999',
    });
    deps.feedbackRepo.setJiraIssueKey.mockRejectedValue(new Error('db blip'));

    const result = await service.submit(SUBMIT);

    expect(deps.emailService.sendFeedbackSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        jiraIssueKey: 'MB-999',
        jiraIssueUrl: 'https://smma-sqe.atlassian.net/browse/MB-999',
      }),
    );
    expect(result).toEqual(ROW);
  });

  it('still saves feedback and does not throw when Jira creation fails', async () => {
    isJiraConfigured.mockReturnValue(true);
    createJiraIssue.mockRejectedValue(new Error('Jira is down'));

    const result = await service.submit(SUBMIT);

    expect(deps.feedbackRepo.setJiraIssueKey).not.toHaveBeenCalled();
    expect(deps.emailService.sendFeedbackSubmittedEmail).toHaveBeenCalled();
    expect(result).toEqual(ROW);
  });

  it('still saves the feedback row even when the user/workspace lookups throw', async () => {
    deps.userRepo.findById.mockRejectedValue(new Error('db down'));
    deps.workspaceRepo.findById.mockRejectedValue(new Error('db down'));

    const result = await service.submit(SUBMIT);

    expect(deps.feedbackRepo.create).toHaveBeenCalledWith({
      userId: 'u1',
      title: 'Dark mode',
      message: 'Please add dark mode',
    });
    expect(result).toEqual(ROW);
    expect(deps.emailService.sendFeedbackSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ submitterName: 'Unknown user', workspaceName: 'w1' }),
    );
  });

  it('keeps whichever submitter/workspace lookup succeeds when the other fails', async () => {
    deps.userRepo.findById.mockResolvedValue({ id: 'u1', name: 'Jane Doe', email: 'jane@sqe.co.id' });
    deps.workspaceRepo.findById.mockRejectedValue(new Error('db down'));

    await service.submit(SUBMIT);

    expect(deps.emailService.sendFeedbackSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        submitterName: 'Jane Doe',
        submitterEmail: 'jane@sqe.co.id',
        workspaceName: 'w1',
      }),
    );
  });

  it('creates the feedback row before resolving submitter/workspace details', async () => {
    const callOrder: string[] = [];
    deps.feedbackRepo.create.mockImplementation(async () => {
      callOrder.push('create');
      return ROW;
    });
    deps.userRepo.findById.mockImplementation(async () => {
      callOrder.push('findUser');
      return { id: 'u1', name: 'Jane Doe', email: 'jane@sqe.co.id' };
    });

    await service.submit(SUBMIT);

    expect(callOrder[0]).toBe('create');
  });

  it('still saves feedback and does not throw when the notification email fails', async () => {
    deps.emailService.sendFeedbackSubmittedEmail.mockRejectedValue(new Error('SES is down'));

    const result = await service.submit(SUBMIT);

    expect(result).toEqual(ROW);
  });

  it('falls back to placeholder names when the user or workspace lookup misses', async () => {
    deps.userRepo.findById.mockResolvedValue(null);
    deps.workspaceRepo.findById.mockResolvedValue(null);

    await service.submit(SUBMIT);

    expect(deps.emailService.sendFeedbackSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ submitterName: 'Unknown user', workspaceName: 'w1' }),
    );
  });
});
