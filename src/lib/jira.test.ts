import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function loadJira() {
  vi.resetModules();
  return import('./jira');
}

describe('isJiraConfigured', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('is false when any required env var is missing', async () => {
    process.env.JIRA_BASE_URL = '';
    process.env.JIRA_EMAIL = '';
    process.env.JIRA_API_TOKEN = '';
    const { isJiraConfigured } = await loadJira();
    expect(isJiraConfigured()).toBe(false);
  });

  it('is true once base URL, email, and API token are all set', async () => {
    process.env.JIRA_BASE_URL = 'https://smma-sqe.atlassian.net';
    process.env.JIRA_EMAIL = 'bot@sqe.co.id';
    process.env.JIRA_API_TOKEN = 'token123';
    const { isJiraConfigured } = await loadJira();
    expect(isJiraConfigured()).toBe(true);
  });

  it('is false when the base URL is not https (e.g. misconfigured to http/internal)', async () => {
    process.env.JIRA_BASE_URL = 'http://smma-sqe.atlassian.net';
    process.env.JIRA_EMAIL = 'bot@sqe.co.id';
    process.env.JIRA_API_TOKEN = 'token123';
    const { isJiraConfigured } = await loadJira();
    expect(isJiraConfigured()).toBe(false);
  });

  it('is false when the base URL is not a valid URL', async () => {
    process.env.JIRA_BASE_URL = 'not-a-url';
    process.env.JIRA_EMAIL = 'bot@sqe.co.id';
    process.env.JIRA_API_TOKEN = 'token123';
    const { isJiraConfigured } = await loadJira();
    expect(isJiraConfigured()).toBe(false);
  });
});

describe('createJiraIssue', () => {
  beforeEach(() => {
    process.env.JIRA_BASE_URL = 'https://smma-sqe.atlassian.net';
    process.env.JIRA_EMAIL = 'bot@sqe.co.id';
    process.env.JIRA_API_TOKEN = 'token123';
    process.env.JIRA_PROJECT_KEY = 'MB';
    process.env.JIRA_ISSUE_TYPE = 'Task';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it('throws when Jira is not configured', async () => {
    process.env.JIRA_BASE_URL = '';
    const { createJiraIssue } = await loadJira();
    await expect(
      createJiraIssue({ summary: 'S', description: 'D' }),
    ).rejects.toThrow(/JIRA_BASE_URL/);
  });

  it('posts to the Jira REST API and returns the issue key + browse URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: 'MB-999' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createJiraIssue } = await loadJira();
    const result = await createJiraIssue({ summary: 'New feedback', description: 'Body text' });

    expect(result).toEqual({
      key: 'MB-999',
      url: 'https://smma-sqe.atlassian.net/browse/MB-999',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://smma-sqe.atlassian.net/rest/api/3/issue');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body);
    expect(body.fields.project).toEqual({ key: 'MB' });
    expect(body.fields.summary).toBe('New feedback');
    expect(body.fields.issuetype).toEqual({ name: 'Task' });
  });

  it('bounds the request with a timeout signal so a stalled Jira API cannot hang the caller', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'MB-1' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { createJiraIssue } = await loadJira();
    await createJiraIssue({ summary: 'S', description: 'D' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal.aborted).toBe(false);
  });

  it('splits a multi-line description into one ADF paragraph per line', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ key: 'MB-1' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { createJiraIssue } = await loadJira();
    await createJiraIssue({
      summary: 'S',
      description: 'Please add dark mode\n\nSubmitted by: Jane Doe\nWorkspace: SQE Capital',
    });

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.fields.description.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Please add dark mode' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Submitted by: Jane Doe' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Workspace: SQE Capital' }] },
    ]);
  });

  it('throws with the response status when Jira returns a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => '{"errorMessages":["bad project key"]}',
    });
    vi.stubGlobal('fetch', fetchMock);

    const { createJiraIssue } = await loadJira();
    await expect(
      createJiraIssue({ summary: 'S', description: 'D' }),
    ).rejects.toThrow(/400/);
  });
});
