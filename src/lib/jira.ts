// Minimal Jira Cloud REST (v3) client used to file a ticket whenever a user
// submits in-app feedback (MB-480). Auth is Basic <email>:<api-token>, same
// scheme Jira Cloud requires for API tokens (https://id.atlassian.com).
//
// `JIRA_BASE_URL` is the site root, e.g. https://smma-sqe.atlassian.net.
// `JIRA_PROJECT_KEY` defaults to "MB" (this repo's own project) and
// `JIRA_ISSUE_TYPE` to "Task" — override either if feedback should land
// somewhere else.
const JIRA_BASE_URL = process.env.JIRA_BASE_URL;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'MB';
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE || 'Task';
const JIRA_REQUEST_TIMEOUT_MS = 10_000;

export interface CreateJiraIssueInput {
  summary: string;
  description: string;
}

export interface CreateJiraIssueResult {
  key: string;
  url: string;
}

/**
 * True once the three required Jira env vars are set. Callers should check
 * this before calling {@link createJiraIssue} so a missing/unconfigured
 * integration is a skip, not a thrown error.
 */
export function isJiraConfigured(): boolean {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) return false;
  // Guard against a misconfigured base URL sending Basic Auth credentials
  // somewhere unintended — Jira Cloud is always https.
  try {
    return new URL(JIRA_BASE_URL).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * File a new Jira issue via the Jira Cloud REST API. Throws on any
 * config/transport/non-2xx error — callers decide whether that should block
 * the caller's own flow (it should not, for feedback submission).
 */
export async function createJiraIssue(
  input: CreateJiraIssueInput,
): Promise<CreateJiraIssueResult> {
  if (!isJiraConfigured()) {
    throw new Error(
      'createJiraIssue: JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must be set',
    );
  }

  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  const baseUrl = JIRA_BASE_URL!.replace(/\/+$/, '');

  // Each non-empty line becomes its own ADF paragraph — a single paragraph
  // node's `text` does not render embedded "\n"s as line breaks in Jira.
  const descriptionParagraphs = input.description
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: line }],
    }));

  const response = await fetch(`${baseUrl}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      fields: {
        project: { key: JIRA_PROJECT_KEY },
        summary: input.summary,
        issuetype: { name: JIRA_ISSUE_TYPE },
        description: {
          type: 'doc',
          version: 1,
          content: descriptionParagraphs,
        },
      },
    }),
    // A stalled Jira Cloud request would otherwise hang the caller
    // indefinitely — FeedbackService awaits this inline on the request path.
    signal: AbortSignal.timeout(JIRA_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `createJiraIssue: Jira API returned ${response.status} ${response.statusText} ${body}`,
    );
  }

  const data = (await response.json()) as { key: string };
  return { key: data.key, url: `${baseUrl}/browse/${data.key}` };
}
