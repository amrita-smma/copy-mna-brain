/**
 * Convert a LangGraph checkpoint dump (messages + pending writes) plus the
 * recorded human-decision audit into the TraceData[] shape consumed by
 * src/views/AIWorkforce/trace.tsx.
 *
 * Pure function — no I/O. The caller is responsible for fetching messages
 * (via AgentGraph.getTrace) and the workforce row (for human_decisions and
 * the creator-actor lookup).
 *
 * Granularity: one TraceData per AIMessage. ToolMessages fold into their
 * originating AIMessage's tool_calls[i].output by matching tool_call_id.
 * HumanMessages are skipped (they're the user prompt, surfaced separately
 * above the trace).
 *
 * Timestamps: BaseMessage doesn't carry per-message timestamps. We match
 * messages against checkpoint writes via matchMessageTimestamps (reading
 * the checkpoint child/write ts), falling back to started_at when timestamps
 * are omitted, unmatched, or for steps not tied to a message.
 */
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessage, ToolMessage, HumanMessage } from "@langchain/core/messages";
import type { CheckpointPendingWrite } from "@langchain/langgraph-checkpoint";
import type { HumanDecision } from "@/lib/db/schema";
import { ASK_OWNER_TOOL_NAME, readAskOwnerArgs } from "@/lib/agents/analysis/hitl";
import type { CheckpointMessageWrite } from "@/lib/repositories";
import type {
  AvatarTone,
  InterventionAsk,
  InterventionData,
  LiveRow,
  LiveRowStatus,
  ToolCall,
  ToolCallRowTone,
  TraceData,
  TraceOutcomeChip,
  TraceStepStatus,
} from "@/views/AIWorkforce/shared";

const LIVE_ROW_STATUSES: LiveRowStatus[] = [
  "pending",
  "checking",
  "done",
  "fail",
];

function parseLiveRows(args: unknown): LiveRow[] | undefined {
  if (!args || typeof args !== "object") return undefined;
  const items = (args as Record<string, unknown>).items;
  if (!Array.isArray(items)) return undefined;
  const out: LiveRow[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const label = typeof r.label === "string" ? r.label : "";
    const status =
      typeof r.status === "string" &&
      (LIVE_ROW_STATUSES as string[]).includes(r.status)
        ? (r.status as LiveRowStatus)
        : undefined;
    if (!label || !status) continue;
    const detail = typeof r.detail === "string" ? r.detail : undefined;
    out.push(detail ? { label, status, detail } : { label, status });
  }
  return out.length > 0 ? out : undefined;
}

export interface TraceActor {
  id: string;
  name: string;
  initials: string;
  avatarTone: AvatarTone;
}

export interface BuildTraceInput {
  messages: BaseMessage[];
  pendingWrites: CheckpointPendingWrite[];
  humanDecisions: HumanDecision[];
  actor: TraceActor;
  startedAt: string | null;
  // When true, the workforce task has reached a terminal state — suppress
  // any trailing "pending" plan placeholders since no more steps will run.
  terminal?: boolean;
  // When true, the terminal state was a user-initiated cancel (error.code
  // === 'cancelled_by_user'). Trailing plan entries that didn't run are
  // emitted as 'skipped' instead of being hidden, so the user can see what
  // would have happened. Ignored unless `terminal` is also true.
  cancelled?: boolean;
  messageTimestamps?: (string | null)[];
  // Display name of the user a pending intervention is addressed to
  // (pending_intervention.asked_user_id), for "Waiting for <name>".
  waitingFor?: string;
  // Actors keyed by user id, for labelling decisions made by someone other
  // than `actor` (HumanDecision.decided_by_user_id — e.g. an insight owner
  // answering a scheduled refresh). Missing ids fall back to `actor`.
  deciders?: Record<string, TraceActor>;
}

// HITLRequest shape from langchain's humanInTheLoopMiddleware (hitl.js).
// Loosely typed because we read it back from a JSON-decoded pending write.
interface HitlActionRequest {
  name?: unknown;
  args?: unknown;
  description?: unknown;
}
interface HitlRequest {
  actionRequests?: HitlActionRequest[];
}

const DESCRIPTION_MAX = 280;
const ARGS_MAX = 120;

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function coerceContent(content: unknown): string {
  if (typeof content === "string") return content;
  // `@langchain/anthropic` returns a tool-using agent's message content as an
  // array of content blocks (e.g. [{ type: "text", text: "…" }]). Join the
  // text blocks so descriptions / tool output / final reports render as the
  // real text instead of a JSON.stringify'd block wrapper. Non-text arrays and
  // plain objects (e.g. structured tool args) still fall through to JSON.
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (typeof block === "string") return block;
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "text"
        ) {
          return (block as { text?: string }).text ?? "";
        }
        return "";
      })
      .join("");
    if (text) return text;
    // An assistant message with no text block is normal — a turn can be pure
    // thinking + server-side tool use. JSON.stringify-ing it spills the raw
    // block array at the user, including base64 `encrypted_content` and
    // `signature` fields that are megabytes of noise and mean nothing to them.
    // Say nothing rather than that; the tool rows alongside carry the detail.
    return "";
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Fallback parser for final-turn messages where the model forgot to call
 * narrate_step. The workforce system prompt requires final messages to
 * follow either "✓ Done: …" / "✗ Could not complete: …", so we lift the
 * outcome line into a title and use the first detail line as the overview.
 * Returns undefined if the content doesn't match the convention.
 */
function parseFinalReport(
  content: string,
): { title: string; overview: string } | undefined {
  if (!content) return undefined;
  const done = content.match(/^[✓✔]\s*Done:\s*(.+?)\s*$/m);
  const failed = content.match(/^[✗✘]\s*Could not complete:\s*(.+?)\s*$/m);
  const match = done ?? failed;
  if (!match) return undefined;
  const title = (done ? "✓ " : "✗ ") + match[1].trim();
  // First non-empty bullet line after the header, or the next non-empty line.
  const after = content.slice((match.index ?? 0) + match[0].length);
  const detail = after
    .split("\n")
    .map((l) => l.trim().replace(/^[-•]\s*/, ""))
    .find((l) => l.length > 0);
  return { title, overview: detail ?? match[1].trim() };
}

/**
 * Heuristic tool-result → status-badge derivation.
 *
 * Renders the small label that floats right on a tool row in the trace UI
 * (e.g. "5 matches", "promoted", "failed"), along with a tone that picks
 * the pill color. Conservative by design — we return undefined for tools we
 * don't recognize so the badge slot just stays empty rather than rendering
 * misleading text.
 *
 * Adding a new tool: keep the label to <= ~20 chars and surface the most
 * scannable single fact (count, status, ratio). Avoid duplicating what
 * the user can already see in the args.
 */
function deriveToolStatus(
  name: string,
  content: string,
): { label: string; tone: ToolCallRowTone } | undefined {
  if (!content) return undefined;

  // Generic error short-circuit applicable to most tools.
  if (/^\*\*Error:\*\*/i.test(content)) return { label: "error", tone: "fail" };

  switch (name) {
    case "query_companies": {
      const m = content.match(/Query Results \((\d+) compan/i);
      if (m) {
        const n = Number(m[1]);
        const label = `${n} ${n === 1 ? "match" : "matches"}`;
        return { label, tone: n > 0 ? "pass" : "warn" };
      }
      if (/No companies found/i.test(content))
        return { label: "no matches", tone: "warn" };
      return undefined;
    }
    case "get_company_details": {
      if (/No company found/i.test(content))
        return { label: "not found", tone: "warn" };
      return { label: "found", tone: "pass" };
    }
    case "promote_to_l1": {
      if (/^Promoted /i.test(content)) return { label: "promoted", tone: "pass" };
      if (/^Cannot promote/i.test(content))
        return { label: "refused", tone: "fail" };
      if (/^No company found/i.test(content))
        return { label: "not found", tone: "warn" };
      return undefined;
    }
    case "web_search":
      // Tool tends to return a long markdown blob — count source markers.
      {
        const matches = content.match(/^\s*\d+\.\s/gm);
        if (matches && matches.length > 0) {
          const label = `${matches.length} ${
            matches.length === 1 ? "source" : "sources"
          }`;
          return { label, tone: "pass" };
        }
      }
      return undefined;
    case "create_insight": {
      if (/^Created insight/i.test(content))
        return { label: "created", tone: "pass" };
      if (/^Rejection:/i.test(content))
        return { label: "refused", tone: "fail" };
      return undefined;
    }
    case "edit_insight_section": {
      if (/^Updated section/i.test(content))
        return { label: "updated", tone: "pass" };
      if (/^Rejection:/i.test(content))
        return { label: "refused", tone: "fail" };
      return undefined;
    }
    case "replace_insight_document": {
      if (/^Replaced the document/i.test(content))
        return { label: "updated", tone: "pass" };
      if (/^Rejection:/i.test(content))
        return { label: "refused", tone: "fail" };
      return undefined;
    }
    case "get_insight": {
      if (/not found in this workspace/i.test(content))
        return { label: "not found", tone: "warn" };
      if (/^Insight:/i.test(content))
        return { label: "found", tone: "pass" };
      return undefined;
    }
    default:
      return undefined;
  }
}

interface AiMessageLike {
  id?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
}
interface ToolMessageLike {
  tool_call_id?: string;
  content?: unknown;
}

function readAi(msg: BaseMessage): AiMessageLike {
  return msg as unknown as AiMessageLike;
}
function readTool(msg: BaseMessage): ToolMessageLike {
  return msg as unknown as ToolMessageLike;
}

function findResolvedDecision(
  decisions: HumanDecision[],
  toolCallId: string | undefined,
): HumanDecision | undefined {
  if (!toolCallId) return undefined;
  return decisions.find((d) => d.tool_call_id === toolCallId);
}

function buildResolved(
  decision: HumanDecision,
  question: string,
  actor: TraceActor,
): InterventionData {
  let text: string;
  let mappedDecision: "approved" | "modified" | "answered" | "rejected";
  if (decision.tool_name === ASK_OWNER_TOOL_NAME) {
    if (decision.decision === "reject") {
      text = decision.rejection_message
        ? `Declined: ${decision.rejection_message}`
        : "Declined to answer";
      mappedDecision = "rejected";
    } else if (decision.decision === "approve") {
      text = `Accepted the recommendation: ${decision.answer ?? ""}`.trim();
      mappedDecision = "approved";
    } else {
      text = `Answered: ${decision.answer ?? ""}`.trim();
      mappedDecision = "answered";
    }
  } else if (decision.decision === "approve") {
    text = "Approved as proposed";
    mappedDecision = "approved";
  } else if (decision.decision === "edit") {
    text = decision.edited_args
      ? `Edited args: ${truncate(JSON.stringify(decision.edited_args), 200)}`
      : "Edited";
    mappedDecision = "modified";
  } else {
    text = decision.rejection_message ?? "Rejected";
    mappedDecision = "modified";
  }
  return {
    state: "resolved",
    question,
    resolution: {
      actor: actor.name,
      actorInitials: actor.initials,
      avatarTone: actor.avatarTone,
      decision: mappedDecision,
      text,
      timestamp: formatTime(decision.decided_at),
    },
  };
}

interface PendingInterrupt {
  question: string;
  proposal: string | undefined;
  ask: InterventionAsk | undefined;
  toolName: string;
  toolCallId: string | undefined;
}

function deriveInterventionAsk(
  toolName: string,
  args: unknown,
): InterventionAsk | undefined {
  if (toolName !== ASK_OWNER_TOOL_NAME) return undefined;
  const ask = readAskOwnerArgs(args);
  if (!ask) return undefined;
  return {
    recommendation: ask.recommendation,
    ...(ask.rationale ? { rationale: ask.rationale } : {}),
    ...(ask.options ? { options: ask.options } : {}),
  };
}

/**
 * Pull a free-text rationale out of a HITL action request's args. Per-tool
 * because the field name varies by tool: `promote_to_l1` uses `reason`, and
 * its optional `note` (caveats acknowledged by the user) is appended when
 * present so the reviewer sees both in the proposal block. Returns undefined
 * when the tool has no rationale-style arg, leaving `proposal` unset and the
 * intervention card collapsed to question + buttons only.
 */
function deriveInterventionProposal(
  toolName: string,
  args: unknown,
): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  if (toolName === "promote_to_l1") {
    const reason = typeof a.reason === "string" ? a.reason.trim() : "";
    const note = typeof a.note === "string" ? a.note.trim() : "";
    if (!reason && !note) return undefined;
    if (reason && note) return `${reason}\n\nNote: ${note}`;
    return reason || `Note: ${note}`;
  }
  return undefined;
}

function extractPendingInterrupts(
  pendingWrites: CheckpointPendingWrite[],
  lastAiToolCallsByName: Map<string, string>,
): PendingInterrupt[] {
  const out: PendingInterrupt[] = [];
  for (const write of pendingWrites) {
    // CheckpointPendingWrite = [taskId, channel, value]
    const channel = write[1];
    const value = write[2];
    if (channel !== "__interrupt__") continue;
    // The interrupt value is typically a langgraph Interrupt envelope
    // containing the HITLRequest. We grope for `.value.actionRequests`
    // or `.actionRequests` to be permissive across versions.
    const v = value as { value?: HitlRequest } & HitlRequest;
    const req = v?.value ?? v;
    const actions = Array.isArray(req?.actionRequests) ? req.actionRequests : [];
    if (actions.length === 0) continue;
    const first = actions[0];
    const toolName = typeof first?.name === "string" ? first.name : "";
    const descRaw =
      typeof first?.description === "string" ? first.description : "";
    const question =
      descRaw.trim() || `Approval required for ${toolName || "tool call"}`;
    const proposal = deriveInterventionProposal(toolName, first?.args);
    const ask = deriveInterventionAsk(toolName, first?.args);
    out.push({
      question,
      proposal,
      ask,
      toolName,
      toolCallId: toolName ? lastAiToolCallsByName.get(toolName) : undefined,
    });
  }
  return out;
}

export function matchMessageTimestamps(
  messages: BaseMessage[],
  writes: CheckpointMessageWrite[],
): (string | null)[] {
  const aiById = new Map<string, string>();
  const toolByCallId = new Map<string, string>();
  const humanTimestamps: string[] = [];

  for (const w of writes) {
    if (w.kind === "ai" && w.id) {
      if (!aiById.has(w.id)) {
        aiById.set(w.id, w.ts);
      }
    } else if (w.kind === "tool" && w.toolCallId) {
      if (!toolByCallId.has(w.toolCallId)) {
        toolByCallId.set(w.toolCallId, w.ts);
      }
    } else if (w.kind === "human") {
      humanTimestamps.push(w.ts);
    }
  }

  let humanIndex = 0;
  return messages.map((msg) => {
    if (AIMessage.isInstance(msg)) {
      const id = msg.id ?? readAi(msg).id;
      return (id ? aiById.get(id) : undefined) ?? null;
    }
    if (ToolMessage.isInstance(msg)) {
      const toolCallId = readTool(msg).tool_call_id;
      return (toolCallId ? toolByCallId.get(toolCallId) : undefined) ?? null;
    }
    if (HumanMessage.isInstance(msg)) {
      if (humanIndex < humanTimestamps.length) {
        return humanTimestamps[humanIndex++];
      }
      return null;
    }
    return null;
  });
}

export function buildTrace(input: BuildTraceInput): TraceData[] {
  const {
    messages,
    pendingWrites,
    humanDecisions,
    actor,
    startedAt,
    terminal = false,
    cancelled = false,
    messageTimestamps,
    waitingFor,
    deciders,
  } = input;
  const steps: TraceData[] = [];

  // Latest plan declared via narrate_step(plan: [...]). The agent is asked
  // to pass this on its first turn so the UI can show the full outline up
  // front; if it revises later, the most recent value wins. Used only to
  // append "pending" placeholders past the steps we've actually executed.
  let latestPlan: string[] | undefined;
  for (const msg of messages) {
    if (!AIMessage.isInstance(msg)) continue;
    const ai = readAi(msg);
    for (const tc of ai.tool_calls ?? []) {
      if (
        tc?.name !== "narrate_step" ||
        typeof tc.args !== "object" ||
        tc.args === null
      )
        continue;
      const planArg = (tc.args as Record<string, unknown>).plan;
      if (
        Array.isArray(planArg) &&
        planArg.every((p) => typeof p === "string" && p.length > 0)
      ) {
        latestPlan = planArg as string[];
      }
    }
  }

  // First pass: emit a step per AIMessage, fold ToolMessages into the
  // matching tool call's `output`.
  let aiIndex = 0;
  let seenAi = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    
    if (HumanMessage.isInstance(msg)) {
      if (seenAi) {
        const content = coerceContent(msg.content ?? "");
        steps.push({
          id: msg.id ?? `human-${i}`,
          status: 'done',
          stepNumber: aiIndex + 1,
          title: "Follow-up instruction",
          description: content,
          timestamp: formatTime(messageTimestamps?.[i] ?? startedAt),
        });
        aiIndex++;
      }
      continue;
    }

    if (!AIMessage.isInstance(msg)) continue;
    seenAi = true;
    const ai = readAi(msg);
    const toolCalls = Array.isArray(ai.tool_calls) ? ai.tool_calls : [];

    // Lift narration from the (optional) narrate_step tool call. The model
    // calls this as a no-op alongside real work to record structured
    // title / overview for this trace card. We use the args even when
    // the tool hasn't executed yet (e.g. paused on HITL), since the args
    // travel with the AIMessage regardless of execution.
    const narrationCall = toolCalls.find(
      (tc) => typeof tc?.name === "string" && tc.name === "narrate_step",
    );
    let narration: { title: string; overview: string } | undefined;
    if (narrationCall && narrationCall.args && typeof narrationCall.args === "object") {
      const a = narrationCall.args as Record<string, unknown>;
      narration = {
        title: typeof a.title === "string" ? a.title : "",
        overview: typeof a.overview === "string" ? a.overview : "",
      };
    }

    // Lift in-flight iteration snapshot from the (optional) report_progress
    // tool call. Like narrate_step, the tool body is a no-op — we read the
    // args directly off the AIMessage. The most recent call wins if (for
    // some reason) the agent emits more than one in a single turn.
    let liveRows: LiveRow[] | undefined;
    for (const tc of toolCalls) {
      if (typeof tc?.name === "string" && tc.name === "report_progress") {
        const parsed = parseLiveRows(tc.args);
        if (parsed) liveRows = parsed;
      }
    }

    // The "real" tool calls drive status, title, and rendered tool rows —
    // narrate_step and report_progress are internal trace plumbing, not
    // user-facing tool work.
    const realToolCalls = toolCalls.filter(
      (tc) => tc?.name !== "narrate_step" && tc?.name !== "report_progress",
    );

    const aiContent = coerceContent(ai.content ?? "");
    const desc = truncate(aiContent, DESCRIPTION_MAX);

    let anyRunning = false;
    const mappedToolCalls: ToolCall[] = realToolCalls.map((tc): ToolCall => {
      const name = typeof tc?.name === "string" ? tc.name : "(unnamed)";
      const argsStr = truncate(coerceContent(tc?.args ?? {}), ARGS_MAX);
      // Find the matching ToolMessage downstream of this AIMessage.
      let result: BaseMessage | undefined;
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j];
        if (!ToolMessage.isInstance(next)) continue;
        const tm = readTool(next);
        if (tm.tool_call_id && tc?.id && tm.tool_call_id === tc.id) {
          result = next;
          break;
        }
      }
      if (!result) {
        // No ToolMessage downstream — the tool was mid-flight (or paused on
        // a HITL gate) when the trace was captured. If the workforce row is
        // already terminal (user cancel, reaper, etc.), the tool will never
        // complete in this run, so render a neutral 'cancelled' badge
        // instead of a live spinner. Otherwise the agent is genuinely still
        // working and we want the spinner.
        if (terminal) {
          return { name, args: argsStr, status: "cancelled", tone: "default" };
        }
        anyRunning = true;
        return { name, args: argsStr, running: true };
      }
      const tm = readTool(result);
      const rawContent = coerceContent(tm.content ?? "");
      // The expanded panel renders this as markdown when there's no `key`,
      // so we keep enough content for tables and profiles to render whole.
      // Long contents get a scrollbar in the UI; truncation here is just a
      // safety cap to avoid massive payloads on the wire.
      const value = truncate(rawContent, 6000);
      const derived = deriveToolStatus(name, rawContent);
      return {
        name,
        args: argsStr,
        ...(derived ? { status: derived.label, tone: derived.tone } : {}),
        output: {
          label: name,
          rows: [{ value }],
        },
      };
    });

    // Step-level outcome chips: one chip per resolved tool whose tone is
    // pass / fail / warn (skip the neutral 'default' tone). Surfaces a
    // scannable summary on the step header without having to expand tools.
    const outcomeChips: TraceOutcomeChip[] = [];
    for (const tc of mappedToolCalls) {
      if (tc.running || !tc.status || !tc.tone || tc.tone === "default") {
        continue;
      }
      outcomeChips.push({
        label: tc.status,
        tone: tc.tone,
      });
    }

    let status: TraceStepStatus = anyRunning ? "active" : "done";

    // Attach a resolved-intervention if any of this turn's tool calls have a
    // matching audit entry. If multiple, the first wins (current
    // InterventionData supports one per step).
    let intervention: InterventionData | undefined;
    for (const tc of realToolCalls) {
      const decision = findResolvedDecision(humanDecisions, tc?.id);
      if (decision) {
        const question =
          decision.tool_name === ASK_OWNER_TOOL_NAME
            ? decision.question ?? "Question for the owner"
            : decision.decision === "reject"
              ? `Reject ${decision.tool_name}?`
              : `Approve ${decision.tool_name}?`;
        const decider =
          (decision.decided_by_user_id && deciders?.[decision.decided_by_user_id]) ||
          actor;
        intervention = buildResolved(decision, question, decider);
        status = "intervention-resolved";
        break;
      }
    }

    // Final-turn fallback: if the model didn't emit narrate_step on the
    // last turn but did write a "✓ Done:" / "✗ Could not complete:" report
    // (per the workforce system prompt), lift the outcome line into the
    // card. Belt-and-braces alongside the prompt requirement.
    if (!narration && realToolCalls.length === 0) {
      const parsed = parseFinalReport(aiContent);
      if (parsed) narration = parsed;
    }

    // A text-only step (no real tool calls) carries the agent's prose — for
    // the closing turn this is the final report. `description` is truncated
    // for the inline card; keep the full markdown so the UI can render it in
    // a popup ("View full report"). Capped to avoid oversized payloads.
    const fullReport =
      realToolCalls.length === 0 && aiContent.trim().length > 0
        ? truncate(aiContent, 50000)
        : undefined;

    // Prefer narration when present; fall back to derived defaults.
    const autoTitle =
      realToolCalls.length > 0
        ? `Tool ${realToolCalls
            .map((t) => (typeof t.name === "string" ? t.name : "?"))
            .join(", ")}`
        : "Final response";
    const title = narration?.title?.trim() || autoTitle;
    const description =
      (narration?.overview?.trim() || desc) || "(no content)";

    // If the step is ostensibly 'done' but the agent's narration (or fallback parser)
    // explicitly marked it as a failure, flag the step itself as failed so the UI
    // renders a red X instead of a green checkmark.
    if (status === "done" && /^[✗✘]/.test(title)) {
      status = "failed";
    }

    steps.push({
      id: ai.id ?? `step-${aiIndex}`,
      status,
      stepNumber: aiIndex + 1,
      title,
      description,
      timestamp: formatTime(messageTimestamps?.[i] ?? startedAt),
      ...(fullReport ? { fullReport } : {}),
      toolCalls: mappedToolCalls.length > 0 ? mappedToolCalls : undefined,
      ...(outcomeChips.length > 0 ? { outcomeChips } : {}),
      ...(liveRows ? { liveRows } : {}),
      intervention,
    });
    aiIndex++;
  }

  // Second pass: attach pending interrupts to the latest AI step (the one
  // whose tool calls are blocked). Pending interrupts are only meaningful
  // when there's a most-recent AIMessage with unfinished tool calls.
  //
  // Skipped when the workforce row is already terminal — the user cancelled
  // (or the reaper killed) the run, so the LangGraph checkpoint still
  // carries a pending interrupt that will never resolve. Rendering the
  // intervention card would leave clickable Approve/Reject buttons under a
  // FAILED header, which is exactly the bug we're fixing.
  const latestStep = steps[steps.length - 1];
  if (!terminal && latestStep && pendingWrites.length > 0) {
    const lastAi = [...messages].reverse().find((m) => AIMessage.isInstance(m));
    const lastAiToolCallsByName = new Map<string, string>();
    if (lastAi) {
      for (const tc of readAi(lastAi).tool_calls ?? []) {
        if (typeof tc?.name === "string" && typeof tc?.id === "string") {
          // First-write wins if a turn has duplicate tool names.
          if (!lastAiToolCallsByName.has(tc.name)) {
            lastAiToolCallsByName.set(tc.name, tc.id);
          }
        }
      }
    }
    const pending = extractPendingInterrupts(pendingWrites, lastAiToolCallsByName);
    if (pending.length > 0 && !latestStep.intervention) {
      const first = pending[0];
      latestStep.intervention = {
        state: "waiting",
        question: first.question,
        ...(first.proposal ? { proposal: first.proposal } : {}),
        ...(first.ask ? { ask: first.ask } : {}),
        ...(waitingFor ? { waitingFor } : {}),
        tool_call_id: first.toolCallId,
        tool_name: first.toolName || undefined,
      };
      latestStep.status = "intervention-waiting";
    }
  }

  // Append placeholders for plan entries past the steps we've actually
  // executed. Three cases for unrendered trailing plan entries:
  //   - Not terminal: emit as 'pending' (the agent will still get to them).
  //   - Terminal + cancelled-by-user: emit as 'skipped' so the user can see
  //     what would have happened if they hadn't stopped the run.
  //   - Terminal + any other reason (succeeded early, agent failure, reaper,
  //     etc.): suppress — rendering them as "pending" or "skipped" would
  //     misrepresent why the run ended.
  if (latestPlan && latestPlan.length > steps.length) {
    const emit = !terminal ? "pending" : cancelled ? "skipped" : null;
    if (emit) {
      for (let i = steps.length; i < latestPlan.length; i++) {
        steps.push({
          id: `${emit}-${i + 1}`,
          status: emit,
          stepNumber: i + 1,
          title: latestPlan[i],
          description: "",
          timestamp: "",
        });
      }
    }
  }

  return steps;
}
