import type { FeedbackRepository, Tables, WorkspaceRepository } from '@/lib/repositories';
import type { UserRepository } from '@/lib/repositories';
import { createJiraIssue, isJiraConfigured } from '@/lib/jira';
import { EmailService } from './emailService';

const FEEDBACK_NOTIFICATION_EMAIL = 'nico.alimin@smma.id';
/** Shared with the API route so length caps cannot drift between layers. */
export const MAX_FEEDBACK_TITLE_LENGTH = 200;
export const MAX_FEEDBACK_MESSAGE_LENGTH = 5000;

/** Trim + collapse CR/LF so route and service validate the same stored form. */
export function normalizeFeedbackTitle(title: string): string {
  return title.trim().replace(/[\r\n]+/g, ' ');
}

export interface SubmitFeedbackInput {
  userId: string;
  title: string;
  message: string;
}

export class FeedbackService {
  constructor(
    private readonly feedbackRepo: FeedbackRepository,
    private readonly userRepo: UserRepository,
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly workspaceId: string,
    private readonly emailService: EmailService = new EmailService(),
  ) {}

  /**
   * Store a feedback submission, then best-effort file a Jira ticket and email
   * nico.alimin@smma.id. Jira/email failures are logged, not thrown — the
   * user's submission is already durably saved by the time either runs.
   */
  async submit(input: SubmitFeedbackInput): Promise<Tables<'feedback'>> {
    const title = normalizeFeedbackTitle(input.title);
    const message = input.message.trim();
    if (!title) throw new Error('submit: title is required');
    if (title.length > MAX_FEEDBACK_TITLE_LENGTH) {
      throw new Error(
        `submit: title must be ${MAX_FEEDBACK_TITLE_LENGTH} characters or fewer`,
      );
    }
    if (!message) throw new Error('submit: message is required');
    if (message.length > MAX_FEEDBACK_MESSAGE_LENGTH) {
      throw new Error(
        `submit: message must be ${MAX_FEEDBACK_MESSAGE_LENGTH} characters or fewer`,
      );
    }

    // The row must land before anything else runs — a failed metadata lookup
    // or a down Jira/SES must never cost the user their submission.
    const row = await this.feedbackRepo.create({
      userId: input.userId,
      title,
      message,
    });

    let user: Tables<'users'> | null = null;
    let workspace: Tables<'workspaces'> | undefined;
    const [userResult, workspaceResult] = await Promise.allSettled([
      this.userRepo.findById(input.userId),
      this.workspaceRepo.findById(this.workspaceId),
    ]);
    if (userResult.status === 'fulfilled') {
      user = userResult.value;
    } else {
      console.error(
        'FeedbackService.submit: failed to resolve submitter details',
        userResult.reason,
      );
    }
    if (workspaceResult.status === 'fulfilled') {
      workspace = workspaceResult.value;
    } else {
      console.error(
        'FeedbackService.submit: failed to resolve workspace details',
        workspaceResult.reason,
      );
    }

    const submitterName = user?.name || 'Unknown user';
    const submitterEmail = user?.email || 'unknown';
    const workspaceName = workspace?.name || this.workspaceId;

    let jiraIssueKey: string | undefined;
    let jiraIssueUrl: string | undefined;
    let persistedJiraIssueKey: string | undefined;
    if (isJiraConfigured()) {
      try {
        const issue = await createJiraIssue({
          summary: title,
          description: `${message}\n\nSubmitted by: ${submitterName} (${submitterEmail})\nWorkspace: ${workspaceName}`,
        });
        // Keep the link for the notification email even if the DB stamp fails —
        // otherwise the ticket is only recoverable from a console log line.
        jiraIssueKey = issue.key;
        jiraIssueUrl = issue.url;
        try {
          await this.feedbackRepo.setJiraIssueKey(row.id, issue.key);
          persistedJiraIssueKey = issue.key;
        } catch (error) {
          console.error(
            'FeedbackService.submit: Jira issue created but failed to persist key',
            { jiraIssueKey: issue.key, error },
          );
        }
      } catch (error) {
        console.error('FeedbackService.submit: failed to create Jira issue', error);
      }
    }

    try {
      await this.emailService.sendFeedbackSubmittedEmail({
        email: FEEDBACK_NOTIFICATION_EMAIL,
        submitterName,
        submitterEmail,
        workspaceName,
        title,
        message,
        jiraIssueKey,
        jiraIssueUrl,
      });
    } catch (error) {
      console.error('FeedbackService.submit: failed to send notification email', error);
    }

    return persistedJiraIssueKey
      ? { ...row, jira_issue_key: persistedJiraIssueKey }
      : row;
  }
}
