export interface ReportPlanQuestionOption {
  label: string;
  recommended?: boolean;
}

export interface ReportPlanQuestion {
  id: string;
  question: string;
  options: ReportPlanQuestionOption[];
}

export interface ReportPlanApprovalPayload {
  approval_id: string;
  request: string;        // one line restating what the user asked for
  methodology: string;    // the approach the agent intends to take
  questions: ReportPlanQuestion[];
}

/** A human-readable problem, or null when the plan is well formed. */
export function validateReportPlan(
  input: Omit<ReportPlanApprovalPayload, 'approval_id'>,
): string | null {
  const questions = input.questions ?? [];
  if (questions.length > 3) {
    return 'A report plan can have at most 3 questions.';
  }

  for (const q of questions) {
    if (!q.question || !q.question.trim()) {
      return 'Question text must not be empty.';
    }

    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      return 'Each question must have between 2 and 4 options.';
    }

    let recommendedCount = 0;
    for (const opt of q.options) {
      if (!opt.label || !opt.label.trim()) {
        return 'Option labels must not be empty.';
      }
      if (opt.recommended) {
        recommendedCount++;
      }
    }

    if (recommendedCount > 1) {
      return 'At most one option per question can be marked recommended.';
    }
  }

  return null;
}
