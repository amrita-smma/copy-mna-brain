import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { AiWorkforceQueueRepository } from '@/lib/repositories';

const MAX_ROWS = 200;

interface ReorderBody {
  order?: unknown;
}

type ParsedOrder =
  | { order: Array<{ id: string; priority: number }> }
  | { error: string };

// Defensive parser: the request body is JSON the client controls, so we
// validate every field before letting it near the DB. Caps the number of
// rows at MAX_ROWS to keep one rogue caller from issuing thousands of
// UPDATEs in a single transaction.
function parseBody(raw: unknown): ParsedOrder {
  if (!raw || typeof raw !== 'object') return { error: 'invalid body' };
  const b = raw as ReorderBody;
  if (!Array.isArray(b.order)) {
    return { error: 'order must be an array of { id, priority }' };
  }
  if (b.order.length > MAX_ROWS) {
    return { error: `too many rows (max ${MAX_ROWS})` };
  }
  const out: Array<{ id: string; priority: number }> = [];
  const seen = new Set<string>();
  for (const item of b.order) {
    if (!item || typeof item !== 'object') {
      return { error: 'each order item must be an object' };
    }
    const o = item as { id?: unknown; priority?: unknown };
    if (typeof o.id !== 'string' || !o.id) {
      return { error: 'each order item needs a non-empty string id' };
    }
    if (
      typeof o.priority !== 'number' ||
      !Number.isInteger(o.priority) ||
      !Number.isFinite(o.priority)
    ) {
      return { error: 'each priority must be a finite integer' };
    }
    if (seen.has(o.id)) {
      return { error: `duplicate id in order: ${o.id}` };
    }
    seen.add(o.id);
    out.push({ id: o.id, priority: o.priority });
  }
  return { order: out };
}

/**
 * Bulk-renumber the workforce queue. The client supplies a flat list of
 * { id, priority } pairs and the server writes them through. Priorities are
 * absolute — the client decides the scheme (e.g. top = N, bottom = 1).
 *
 * Auth: any logged-in user can reorder. The queue is a shared resource; the
 * decision endpoint still gates HITL approvals per row owner, but reorder
 * is a queue-level operation that anyone with workforce access can perform.
 *
 * The dispatcher's ORDER BY already keys on `priority DESC, created_at ASC`,
 * so the next claim respects whatever this endpoint wrote.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const parsed = parseBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const db = createDb();
    const repo = new AiWorkforceQueueRepository(db);
    await repo.setPriorities(parsed.order);
    return NextResponse.json({ ok: true, updated: parsed.order.length });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Failed to reorder queue';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
