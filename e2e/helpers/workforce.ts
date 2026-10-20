import type { Page, Route } from '@playwright/test';
import { createUIMessageStream, createUIMessageStreamResponse } from 'ai';
import { getDataMode } from './companies';

// Re-export so specs can read the active mode from one place.
export { getDataMode } from './companies';
export const isRealMode = (): boolean => getDataMode() === 'real';

// ─── Wire shapes (mirror the API responses the AIWorkforce views consume) ──────
//
// These intentionally duplicate the inline `ApiQueueItem` / `ApiRoutine` /
// `TraceData` types from src/views/AIWorkforce so the e2e suite stays a
// standalone TS project with no app imports.

export type WorkforceQueueStatus =
  | 'pending'
  | 'running'
  | 'waiting_for_human_input'
  | 'waiting_for_subagent'
  | 'resume_ready'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'timed_out';

export type TriggerSource = 'chat' | 'cron' | 'webhook' | 'api';

/** A row in GET /api/workforce-queue (already enriched with the submitter name). */
export interface QueueItem {
  id: string;
  agent_name: string;
  trigger_source: TriggerSource;
  status: WorkforceQueueStatus;
  priority: number;
  input: Record<string, unknown>;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  origin_routine_id: string | null;
  triggered_by_user_id: string | null;
  triggered_by_user_name: string | null;
  error?: Record<string, unknown> | null;
}

/** A row in GET /api/routines. */
export interface Routine {
  id: string;
  title: string;
  prompt: string;
  schedule_kind: 'daily' | 'weekly' | 'monthly' | 'cron';
  schedule_spec: Record<string, unknown>;
  cron_expression: string;
  timezone: string;
  agent_name: string | null;
  priority: number;
  enabled: boolean;
  last_fired_at: string | null;
  next_fire_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** A row in GET /api/routines/:id/runs. */
export interface RoutineRun {
  id: string;
  status: WorkforceQueueStatus;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
}

export type TraceStepStatus =
  | 'done'
  | 'active'
  | 'pending'
  | 'skipped'
  | 'intervention-waiting'
  | 'intervention-resolved';

export interface InterventionWaiting {
  state: 'waiting';
  question: string;
  proposal?: string;
  tool_call_id?: string;
  tool_name?: string;
}

export interface InterventionResolved {
  state: 'resolved';
  question: string;
  resolution: {
    actor: string;
    actorInitials: string;
    avatarTone: string;
    decision: 'approved' | 'modified';
    text: string;
    timestamp: string;
  };
}

export interface TraceStep {
  id: string;
  status: TraceStepStatus;
  stepNumber: number;
  title: string;
  description: string;
  timestamp: string;
  fullReport?: string;
  intervention?: InterventionWaiting | InterventionResolved;
}

export interface TraceActor {
  id: string;
  name: string;
  initials: string;
  avatarTone: string;
}

/** Shape of GET /api/workforce-queue/:id/trace. */
export interface TraceResponse {
  steps: TraceStep[];
  canDecide: boolean;
  status: WorkforceQueueStatus;
  actor: TraceActor;
  notifications: unknown[];
}

// ─── Factories ──────────────────────────────────────────────────────────────

export const baseActor = (overrides: Partial<TraceActor> = {}): TraceActor => ({
  id: 'user-1',
  name: 'Test User',
  initials: 'TU',
  avatarTone: 'indigo',
  ...overrides,
});

export const baseQueueItem = (overrides: Partial<QueueItem> = {}): QueueItem => ({
  id: 'task-0',
  agent_name: 'analysis',
  trigger_source: 'chat',
  status: 'pending',
  priority: 0,
  input: { title: 'Untitled task', instruction: 'Do the thing.' },
  created_at: '2026-06-25T08:00:00Z',
  started_at: null,
  ended_at: null,
  origin_routine_id: null,
  triggered_by_user_id: 'user-1',
  triggered_by_user_name: 'Test User',
  error: null,
  ...overrides,
});

export const baseRoutine = (overrides: Partial<Routine> = {}): Routine => ({
  id: 'routine-0',
  title: 'Daily APAC Scan',
  prompt: 'Scan APAC sources for new CMP slurry suppliers.',
  schedule_kind: 'daily',
  schedule_spec: { time: '06:00' },
  cron_expression: '0 6 * * *',
  timezone: 'Asia/Jakarta',
  agent_name: 'analysis',
  priority: 0,
  enabled: true,
  last_fired_at: null,
  next_fire_at: '2026-06-26T06:00:00Z',
  created_by: 'user-1',
  created_at: '2026-06-20T06:00:00Z',
  updated_at: '2026-06-20T06:00:00Z',
  archived_at: null,
  ...overrides,
});

export const baseRoutineRun = (overrides: Partial<RoutineRun> = {}): RoutineRun => ({
  id: 'run-0',
  status: 'succeeded',
  created_at: '2026-06-24T06:00:00Z',
  started_at: '2026-06-24T06:00:05Z',
  ended_at: '2026-06-24T06:02:30Z',
  title: 'Daily APAC Scan',
  ...overrides,
});

export const baseTraceStep = (overrides: Partial<TraceStep> = {}): TraceStep => ({
  id: 'step-0',
  status: 'done',
  stepNumber: 1,
  title: 'Search configured sources',
  description: 'Queried the SEMI directory.',
  timestamp: '06:00:05',
  ...overrides,
});

export const traceResponse = (
  steps: TraceStep[],
  overrides: Partial<Omit<TraceResponse, 'steps'>> = {},
): TraceResponse => ({
  steps,
  canDecide: true,
  status: 'running',
  actor: baseActor(),
  notifications: [],
  ...overrides,
});

// ─── Fixtures + mock injection ────────────────────────────────────────────────

export interface WorkforceFixtures {
  /** Rows served by GET /api/workforce-queue (and GET /:id). */
  items?: QueueItem[];
  /** Rows served by GET /api/routines. */
  routines?: Routine[];
  /** Runs served by GET /api/routines/:id/runs, keyed by routine id. */
  runsById?: Record<string, RoutineRun[]>;
  /** Trace served by GET /api/workforce-queue/:id/trace, keyed by task id. */
  traces?: Record<string, TraceResponse>;
  /**
   * Trace returned for a task *after* its intervention is decided. When a
   * POST /:id/decision lands, subsequent trace GETs for that id serve this
   * variant — lets a test exercise the approve→resolved transition.
   */
  tracesResolved?: Record<string, TraceResponse>;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

const QUEUE_RE = {
  list: /\/api\/workforce-queue$/,
  reorder: /\/api\/workforce-queue\/reorder$/,
  trace: /\/api\/workforce-queue\/([^/]+)\/trace$/,
  cancel: /\/api\/workforce-queue\/([^/]+)\/cancel$/,
  retry: /\/api\/workforce-queue\/([^/]+)\/retry$/,
  decision: /\/api\/workforce-queue\/([^/]+)\/decision$/,
  single: /\/api\/workforce-queue\/([^/]+)$/,
};

const ROUTINE_RE = {
  list: /\/api\/routines$/,
  runs: /\/api\/routines\/([^/]+)\/runs$/,
  single: /\/api\/routines\/([^/]+)$/,
};

/**
 * Intercept every AI-Workforce API call and answer from in-memory fixtures.
 * The arrays are mutated by write endpoints (cancel flips a row to cancelled,
 * retry appends a fresh pending row, routine-create appends a routine, a
 * manual run appends a queued row) so the UI stays self-consistent across the
 * page's polling refetches — mirroring `interceptCompanies` in companies.ts.
 */
const mockWorkforce = async (page: Page, fixtures: WorkforceFixtures) => {
  const items: QueueItem[] = [...(fixtures.items ?? [])];
  const routines: Routine[] = [...(fixtures.routines ?? [])];
  const runsById: Record<string, RoutineRun[]> = { ...(fixtures.runsById ?? {}) };
  const traces: Record<string, TraceResponse> = { ...(fixtures.traces ?? {}) };
  const tracesResolved = fixtures.tracesResolved ?? {};
  const decided = new Set<string>();

  await page.route('**/api/workforce-queue**', async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;

    if (method === 'GET' && QUEUE_RE.list.test(path)) {
      return json(route, { items });
    }
    if (method === 'POST' && QUEUE_RE.reorder.test(path)) {
      return json(route, { data: { success: true } });
    }

    const traceMatch = path.match(QUEUE_RE.trace);
    if (method === 'GET' && traceMatch) {
      const id = traceMatch[1];
      const resolved = decided.has(id) ? tracesResolved[id] : undefined;
      const trace = resolved ?? traces[id] ?? traceResponse([], { status: 'pending' });
      return json(route, trace);
    }

    const cancelMatch = path.match(QUEUE_RE.cancel);
    if (method === 'POST' && cancelMatch) {
      const id = cancelMatch[1];
      const item = items.find((i) => i.id === id);
      if (!item) return json(route, { error: 'Not found' }, 404);
      item.status = 'failed';
      item.ended_at = '2026-06-25T08:05:00Z';
      item.error = { code: 'cancelled_by_user' };
      return json(route, { item });
    }

    const retryMatch = path.match(QUEUE_RE.retry);
    if (method === 'POST' && retryMatch) {
      const id = retryMatch[1];
      const source = items.find((i) => i.id === id);
      if (!source) return json(route, { error: 'Not found' }, 404);
      const fresh: QueueItem = {
        ...source,
        id: `${id}-retry`,
        status: 'pending',
        started_at: null,
        ended_at: null,
        error: null,
        created_at: '2026-06-25T08:10:00Z',
      };
      items.unshift(fresh);
      traces[fresh.id] = traceResponse([], { status: 'pending' });
      return json(route, { item: fresh });
    }

    const decisionMatch = path.match(QUEUE_RE.decision);
    if (method === 'POST' && decisionMatch) {
      const id = decisionMatch[1];
      decided.add(id);
      const item = items.find((i) => i.id === id);
      if (item) item.status = 'running';
      return json(route, { data: { success: true } });
    }

    const singleMatch = path.match(QUEUE_RE.single);
    if (method === 'GET' && singleMatch) {
      const item = items.find((i) => i.id === singleMatch[1]) ?? null;
      if (!item) return json(route, { error: 'Not found' }, 404);
      return json(route, { item });
    }

    return route.fallback();
  });

  await page.route('**/api/routines**', async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;

    if (method === 'GET' && ROUTINE_RE.list.test(path)) {
      return json(route, { items: routines });
    }
    if (method === 'POST' && ROUTINE_RE.list.test(path)) {
      const body = (req.postDataJSON() ?? {}) as Partial<Routine>;
      const created = baseRoutine({
        id: `routine-${routines.length + 1}`,
        title: body.title ?? 'New Routine',
        prompt: body.prompt ?? '',
        schedule_kind: body.schedule_kind ?? 'daily',
        schedule_spec: body.schedule_spec ?? { time: '06:00' },
        timezone: body.timezone ?? 'Asia/Jakarta',
      });
      routines.push(created);
      return json(route, { item: created }, 201);
    }

    const runsMatch = path.match(ROUTINE_RE.runs);
    if (runsMatch) {
      const id = runsMatch[1];
      if (method === 'GET') return json(route, { items: runsById[id] ?? [] });
      if (method === 'POST') {
        // Manual "Add to current queue" — surface a fresh queued row so the
        // parent's queue refetch shows it, then ack with the run id.
        items.push(
          baseQueueItem({
            id: `manual-${id}`,
            status: 'pending',
            trigger_source: 'api',
            origin_routine_id: id,
            input: { title: routines.find((r) => r.id === id)?.title ?? 'Manual run' },
            created_at: '2026-06-25T08:15:00Z',
          }),
        );
        return json(route, { runId: `run-manual-${id}`, created: true }, 201);
      }
    }

    const singleMatch = path.match(ROUTINE_RE.single);
    if (singleMatch && (method === 'PATCH' || method === 'DELETE')) {
      const id = singleMatch[1];
      const idx = routines.findIndex((r) => r.id === id);
      if (idx === -1) return json(route, { error: 'Not found' }, 404);
      if (method === 'DELETE') {
        const [removed] = routines.splice(idx, 1);
        return json(route, { item: { ...removed, archived_at: '2026-06-25T08:20:00Z' } });
      }
      const body = (req.postDataJSON() ?? {}) as Partial<Routine>;
      routines[idx] = { ...routines[idx], ...body };
      return json(route, { item: routines[idx] });
    }

    return route.fallback();
  });
};

// ─── Real-mode routine seeding ────────────────────────────────────────────────

export interface ProvisionedWorkforce {
  routines: Routine[];
  /** Unique token embedded in seeded routine titles (real mode only). */
  marker: string;
  cleanup: () => Promise<void>;
}

export const uniqueMarker = (): string =>
  `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

interface RoutineCreatePayload {
  title: string;
  prompt: string;
  schedule_kind: 'daily' | 'weekly' | 'monthly' | 'cron';
  schedule_spec: Record<string, unknown>;
  timezone: string;
}

/**
 * Delete every routine whose title carries `marker`. Used by real-mode tests
 * that create routines through the UI — they embed the marker in the name so
 * teardown can find and archive exactly the rows this run created.
 */
export const cleanupRoutinesByMarker = async (page: Page, marker: string) => {
  if (!marker) return;
  try {
    const res = await page.request.get('/api/routines');
    if (!res.ok()) return;
    const { items } = (await res.json()) as { items: Routine[] };
    for (const r of items ?? []) {
      if (r.title?.includes(marker)) {
        await page.request.delete(`/api/routines/${encodeURIComponent(r.id)}`);
      }
    }
  } catch {
    // Best-effort teardown.
  }
};

const seedRoutinesViaApi = async (
  page: Page,
  payloads: RoutineCreatePayload[],
  registerCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<ProvisionedWorkforce> => {
  const marker = uniqueMarker();
  const cleanup = () => cleanupRoutinesByMarker(page, marker);
  registerCleanup?.(cleanup);

  const routines: Routine[] = [];
  for (const payload of payloads) {
    const res = await page.request.post('/api/routines', {
      data: { ...payload, title: `${payload.title} ${marker}` },
    });
    if (!res.ok()) {
      throw new Error(`Failed to seed routine: ${res.status()} ${await res.text()}`);
    }
    const { item } = (await res.json()) as { item: Routine };
    routines.push(item);
  }
  return { routines, marker, cleanup };
};

/**
 * Make AI-Workforce fixtures available to the page in whichever way the active
 * `E2E_DATA_MODE` dictates. Call *after* auth (real mode needs the session
 * cookie to POST) and *before* navigating.
 *
 * `mock` — intercept every queue/routine/trace endpoint and serve fixtures.
 * `real` — POST the requested `routines` to the live API (marker-scoped, with
 *   cleanup). Queue rows and traces are produced by the agent runtime and
 *   cannot be injected deterministically, so passing `items`/`traces` in real
 *   mode is a hard error — those specs must `test.skip(isRealMode())`.
 */
export const provisionWorkforce = async (
  page: Page,
  fixtures: WorkforceFixtures,
  registerCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<ProvisionedWorkforce> => {
  if (isRealMode()) {
    if ((fixtures.items?.length ?? 0) > 0 || fixtures.traces || fixtures.runsById) {
      throw new Error(
        'real mode cannot seed workforce queue items/traces/runs — guard the test with test.skip(isRealMode()).',
      );
    }
    const payloads: RoutineCreatePayload[] = (fixtures.routines ?? []).map((r) => ({
      title: r.title,
      prompt: r.prompt,
      schedule_kind: r.schedule_kind,
      schedule_spec: r.schedule_spec,
      timezone: r.timezone,
    }));
    return seedRoutinesViaApi(page, payloads, registerCleanup);
  }
  await mockWorkforce(page, fixtures);
  return { routines: fixtures.routines ?? [], marker: '', cleanup: async () => {} };
};

// ─── CoPilot chat mock (for the Workforce handoff / escalation flow) ───────────
//
// The CoPilot chat streams the AI SDK "UI message stream" protocol from
// /api/chat. Rather than hand-author that SSE (version-fragile), we build the
// stream with the app's *own* `ai` package so it is always protocol-matched,
// then replay it from a route mock. The escalation card renders when an
// assistant turn carries a `propose_workforce_handoff` tool part whose output
// holds a WORKFORCE_HANDOFF_JSON marker — see ChatMessageBubble.

/** Payload the WorkforceHandoffCard reads out of the tool-output marker. */
export interface HandoffPayload {
  handoff_id: string;
  title: string;
  rationale: string;
  instruction: string;
  agent_name: string;
  company_ids?: string[];
}

/** Payload the BulkDropCompaniesCard reads out of its tool-output marker. */
export interface BulkDropCandidate {
  id: string;
  name: string;
  current_stage: string | null;
  tag?: string;
  reason: string;
  meta?: string;
}
export interface BulkDropPayload {
  approval_id?: string;
  title: string;
  description: string;
  candidates: BulkDropCandidate[];
}

/** Payload the BulkPromoteCompaniesCard reads out of its tool-output marker. */
export interface BulkPromoteSignal {
  label: string;
  value: string;
  status?: 'pass' | 'fail' | 'warn';
}
export interface BulkPromoteCandidate {
  id: string;
  name: string;
  current_stage: string | null;
  tags?: string[];
  reason: string;
  signals?: BulkPromoteSignal[];
  meta?: string;
}
export interface BulkPromotePayload {
  approval_id?: string;
  title: string;
  description: string;
  target_stage: string;
  candidates: BulkPromoteCandidate[];
}

const buildStreamBody = async (
  chunks: Array<Record<string, unknown>>,
): Promise<{ body: string; headers: Record<string, string> }> => {
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      for (const c of chunks) writer.write(c as never);
    },
  });
  const res = createUIMessageStreamResponse({ stream });
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { body, headers };
};

export interface CopilotChatOptions {
  /** When set, the first assistant turn renders the escalation handoff card. */
  handoff?: HandoffPayload;
  /** When set, the first assistant turn renders the bulk-drop approval card. */
  bulkDrop?: BulkDropPayload;
  /** When set, the first assistant turn renders the bulk-promote approval card. */
  bulkPromote?: BulkPromotePayload;
  /** Queue id returned by POST /api/workforce-queue when the card is assigned. */
  assignedQueueId?: string;
}

/**
 * Intercept the CoPilot chat endpoints so the escalation flow is deterministic:
 * - GET  /api/copilot/chats[/...]      → empty sidebar / history
 * - POST /api/chat/cache-check         → no cache hit (always sends)
 * - POST /api/chat                     → first call streams the handoff card
 *                                        (if `handoff` set), later calls stream
 *                                        a plain inline answer
 * - GET  /api/workforce-queue?...      → card mount lookup returns no prior row
 * - POST /api/workforce-queue          → assign succeeds with `assignedQueueId`
 */
export const mockCopilotChat = async (page: Page, opts: CopilotChatOptions = {}) => {
  const assignedId = opts.assignedQueueId ?? 'queued-task-1';

  // First assistant turn: a tool card (handoff / bulk drop / bulk promote)
  // when requested, else a plain inline answer. Each card renders from a tool
  // part whose output content carries the matching marker (see ChatMessageBubble).
  const cardSpec = opts.handoff
    ? {
        toolName: 'propose_workforce_handoff',
        marker: 'WORKFORCE_HANDOFF_JSON',
        payload: opts.handoff as unknown,
      }
    : opts.bulkDrop
      ? {
          toolName: 'propose_bulk_drop_companies',
          marker: 'BULK_DROP_APPROVAL_JSON',
          payload: opts.bulkDrop as unknown,
        }
      : opts.bulkPromote
        ? {
            toolName: 'propose_bulk_promote_companies',
            marker: 'BULK_PROMOTE_APPROVAL_JSON',
            payload: opts.bulkPromote as unknown,
          }
        : null;

  const handoffChunks = cardSpec
    ? [
        { type: 'start' },
        {
          type: 'tool-input-available',
          toolCallId: 'card-tc',
          toolName: cardSpec.toolName,
          input: {},
          dynamic: true,
        },
        {
          type: 'tool-output-available',
          toolCallId: 'card-tc',
          output: `Proposing an action.\n<!-- ${cardSpec.marker}:${JSON.stringify(cardSpec.payload)} -->`,
          dynamic: true,
        },
        { type: 'text-start', id: 'h-text' },
        { type: 'text-delta', id: 'h-text', delta: 'Here is what I propose.' },
        { type: 'text-end', id: 'h-text' },
        { type: 'finish' },
      ]
    : null;
  const plainChunks = [
    { type: 'start' },
    { type: 'text-start', id: 'p-text' },
    { type: 'text-delta', id: 'p-text', delta: 'Answering inline here — no Workforce task created.' },
    { type: 'text-end', id: 'p-text' },
    { type: 'finish' },
  ];

  const handoffBody = handoffChunks ? await buildStreamBody(handoffChunks) : null;
  const plainBody = await buildStreamBody(plainChunks);

  let chatCalls = 0;

  await page.route('**/api/copilot/chats**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/messages')) return json(route, { messages: [] });
    if (path.endsWith('/fork')) return json(route, { data: { chatId: 'forked-1' } });
    return json(route, { chats: [] });
  });

  await page.route('**/api/chat/cache-check', (route) =>
    json(route, { data: { hit: false } }),
  );

  await page.route('**/api/chat', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const picked = handoffBody && chatCalls === 0 ? handoffBody : plainBody;
    chatCalls += 1;
    await route.fulfill({
      status: 200,
      headers: { ...picked.headers, 'X-Chat-Id': 'copilot-chat-1' },
      body: picked.body,
    });
  });

  await page.route('**/api/workforce-queue**', (route) => {
    const req = route.request();
    if (req.method() === 'GET') return json(route, { item: null });
    if (req.method() === 'POST') {
      return json(route, {
        data: { id: assignedId, status: 'pending', created_at: '2026-06-25T08:00:00Z' },
      });
    }
    return route.fallback();
  });

  // Bulk approval card writes — the card only checks res.ok.
  await page.route('**/api/companies/drop-bulk', (route) =>
    json(route, { data: { success: true } }),
  );
  await page.route('**/api/companies/promote-bulk', (route) =>
    json(route, { data: { success: true } }),
  );
};
