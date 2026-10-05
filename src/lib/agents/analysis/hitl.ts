/**
 * Workforce human-in-the-loop (HITL) configuration, kept free of any LangChain
 * runtime import so the decision route, the trace mapper, the email notifier
 * and tests can share it without pulling the agent stack in.
 *
 * Two halves that must agree:
 *   - WORKFORCE_HITL_INTERRUPT_ON — what `humanInTheLoopMiddleware` gates and
 *     which middleware decision types it accepts per tool (agent index.ts).
 *   - allowedApiDecisions / buildResumeDecision — what the decision route
 *     accepts from the UI, and how a UI decision becomes the middleware's
 *     resume payload.
 */

export const ASK_OWNER_TOOL_NAME = 'ask_owner';
export const PROMOTE_TO_L1_TOOL_NAME = 'promote_to_l1';

/** The decision types langchain's humanInTheLoopMiddleware understands. */
export type MiddlewareDecisionType = 'approve' | 'edit' | 'reject';

/**
 * Decisions the decision route accepts from the UI. For ask_owner, `approve`
 * means "accept the recommendation" and `answer` means "answer differently".
 */
export type ApiDecision = 'approve' | 'answer' | 'reject';

type ToolCallLike = { name?: string; args?: unknown };

/**
 * Gating policy (see RoutineCanvas + TaskCanvas for the UI half):
 *   - Adding a company at an intake stage below L1 (`market_screening` or
 *     `discovered`) — AUTO. The agent executes without human approval; these
 *     are triage/intake stages, not commitments. The `add_company` tool covers
 *     both (it cannot write to L0) and must NOT be listed here.
 *   - Promoting a company to L1 or higher — GATED. The agent must hand off
 *     to a human via this middleware; the human approves or rejects in the
 *     routine/task canvas before the tool runs.
 *   - ask_owner — GATED by construction: the tool exists to pause the run
 *     until the owner answers (MB-561).
 *
 * Today only `promote_to_l1` is stage-changing; when additional stage-changing
 * tools land (e.g. promote_to_l2), add them here so the L1+ rule keeps
 * holding. Read-only tools and L0 entry tools must NEVER appear here.
 */
export const WORKFORCE_HITL_INTERRUPT_ON = {
  [PROMOTE_TO_L1_TOOL_NAME]: {
    allowedDecisions: ['approve', 'reject'] as MiddlewareDecisionType[],
    // The description is what the human reviewer reads in the HITL card
    // (mapped to `intervention.question`). The args.reason carries the
    // longer rationale and is rendered separately as `intervention.proposal`
    // in the trace UI — see traceMapper.ts.
    description: (toolCall: ToolCallLike): string => {
      const args = (toolCall.args ?? {}) as { company_name?: string };
      const co = args.company_name ?? '(unknown)';
      // The tool promotes into whichever stage follows L0 in the workspace;
      // the call args don't carry it, so the question doesn't name it.
      return `Promote ${co} from L0 to the next stage?`;
    },
  },
  [ASK_OWNER_TOOL_NAME]: {
    // Only `edit`. Every owner decision — accept, answer differently, decline —
    // is an edit the decision route builds from the stored args
    // (buildResumeDecision):
    //   - no `approve`: it runs the tool on the agent's own args, so an
    //     owner_answer the agent filled in itself would pass as the owner's;
    //   - no `reject`: the middleware then jumps straight back to the model,
    //     leaving any parallel ungated call (narrate_step, on nearly every
    //     workforce turn) without a tool result, which Anthropic refuses on
    //     the next call. A decline instead runs the tool, which returns the
    //     do-not-guess text itself.
    allowedDecisions: ['edit'] as MiddlewareDecisionType[],
    description: (toolCall: ToolCallLike): string =>
      readAskOwnerArgs(toolCall.args)?.question ?? 'The agent has a question for you',
  },
};

const API_DECISIONS_BY_TOOL: Record<string, readonly ApiDecision[]> = {
  [PROMOTE_TO_L1_TOOL_NAME]: ['approve', 'reject'],
  [ASK_OWNER_TOOL_NAME]: ['approve', 'answer', 'reject'],
};

/** UI decisions the route accepts for a paused tool. Unknown tools: approve/reject. */
export function allowedApiDecisions(toolName: string): readonly ApiDecision[] {
  return API_DECISIONS_BY_TOOL[toolName] ?? ['approve', 'reject'];
}

export interface AskOwnerArgs {
  question: string;
  recommendation: string;
  rationale: string;
  options?: string[];
}

/**
 * The agent-authored ask_owner fields out of a (JSON-decoded) args object.
 * Drops the owner_* fields — those are only ever set by the decision route.
 * Null when question or recommendation is missing.
 */
export function readAskOwnerArgs(args: unknown): AskOwnerArgs | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  const question = typeof a.question === 'string' ? a.question.trim() : '';
  const recommendation =
    typeof a.recommendation === 'string' ? a.recommendation.trim() : '';
  if (!question || !recommendation) return null;
  const rationale = typeof a.rationale === 'string' ? a.rationale.trim() : '';
  const options = Array.isArray(a.options)
    ? a.options
        .filter((o): o is string => typeof o === 'string')
        .map((o) => o.trim())
        .filter(Boolean)
    : [];
  return {
    question,
    recommendation,
    rationale,
    ...(options.length > 0 ? { options } : {}),
  };
}

/** Tool-result text the agent receives when the owner declines an ask_owner question. */
export function buildAskOwnerDeclinedMessage(
  question: string | undefined,
  reason?: string,
): string {
  const asked = question ? ` to answer "${question}"` : '';
  const said = reason?.trim() ? ` Their note: "${reason.trim()}".` : '';
  return (
    `The owner declined${asked}.${said} Do not guess an answer and do not ` +
    'proceed on your recommendation. Either finish without changing anything ' +
    '(a scheduled refresh then records the insight as unchanged), or, if the ' +
    'task cannot be completed soundly without this answer, end with ' +
    '"✗ Could not complete: <why>".'
  );
}

// The agent-authored args re-issued on an edit. The tool schema requires a
// non-empty rationale; the interrupt fires before schema validation, so a call
// that omitted it must not make the owner's decision fail validation.
function toolArgsFrom(ask: AskOwnerArgs): AskOwnerArgs {
  return { ...ask, rationale: ask.rationale || '(none given)' };
}

export type ResumeDecision =
  | { type: 'approve' }
  | { type: 'edit'; editedAction: { name: string; args: Record<string, unknown> } }
  | { type: 'reject'; message?: string };

export type BuildResumeDecisionResult =
  | { ok: true; decision: ResumeDecision; answer?: string; question?: string }
  | { ok: false; error: string };

/**
 * Turn a UI decision on a paused tool into the middleware's resume decision.
 * `toolName` and `storedArgs` come from the row's pending_intervention (server
 * state), never from the request body.
 *
 * promote_to_l1 (and any unknown tool): approve → approve, reject → reject with
 * the optional message — unchanged from before MB-561.
 *
 * ask_owner: every decision is an edit (see WORKFORCE_HITL_INTERRUPT_ON) —
 * approve (accept recommendation) carries the recommendation as the owner's
 * answer, answer carries the owner's text, and reject carries
 * owner_decision 'declined' (plus the owner's note), for which the tool tells
 * the agent not to guess.
 */
export function buildResumeDecision(input: {
  toolName: string;
  decision: ApiDecision;
  storedArgs: unknown;
  answer?: string;
  rejectionMessage?: string;
}): BuildResumeDecisionResult {
  const { toolName, decision } = input;
  if (!allowedApiDecisions(toolName).includes(decision)) {
    return {
      ok: false,
      error: `decision '${decision}' is not allowed for ${toolName}; expected one of ${allowedApiDecisions(toolName).join(', ')}`,
    };
  }

  if (toolName !== ASK_OWNER_TOOL_NAME) {
    return decision === 'approve'
      ? { ok: true, decision: { type: 'approve' } }
      : { ok: true, decision: { type: 'reject', message: input.rejectionMessage } };
  }

  const ask = readAskOwnerArgs(input.storedArgs);
  // A decline must work even for a malformed call (the model can emit one; the
  // interrupt fires before schema validation), or the run would be stuck —
  // so fill the required fields with placeholders the schema accepts.
  if (decision === 'reject') {
    const note = input.rejectionMessage?.trim();
    return {
      ok: true,
      ...(ask ? { question: ask.question } : {}),
      decision: {
        type: 'edit',
        editedAction: {
          name: ASK_OWNER_TOOL_NAME,
          args: {
            ...(ask ? toolArgsFrom(ask) : {
              question: '(unreadable question)',
              recommendation: '(none)',
              rationale: '(none given)',
            }),
            owner_decision: 'declined',
            ...(note ? { owner_answer: note } : {}),
          },
        },
      },
    };
  }
  if (!ask) {
    return {
      ok: false,
      error: 'the paused question has no readable question/recommendation; it can only be rejected',
    };
  }
  const answer = decision === 'approve' ? ask.recommendation : input.answer?.trim() ?? '';
  if (!answer) {
    return { ok: false, error: 'answer is required' };
  }
  return {
    ok: true,
    question: ask.question,
    answer,
    decision: {
      type: 'edit',
      editedAction: {
        name: ASK_OWNER_TOOL_NAME,
        args: {
          ...toolArgsFrom(ask),
          owner_decision: decision === 'approve' ? 'accepted' : 'answered',
          owner_answer: answer,
        },
      },
    },
  };
}
