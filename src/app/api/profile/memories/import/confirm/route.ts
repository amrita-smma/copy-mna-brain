import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { copilotMemoryEnabled } from '@/lib/flags';
import { MemoryUnavailableError } from '@/lib/services/userMemoryService';
import { MAX_IMPORT_STATEMENTS } from '@/lib/memory/limits';
import { describeMemoryFailure } from '@/lib/memory/failures';

/** mem0 de-duplicates in batches; a long confirmed list is several LLM calls. */
export const maxDuration = 300;

/**
 * Step two of importing memories: store the statements the user approved.
 *
 * The body carries what they actually confirmed — which may differ from what
 * `../import` proposed, because the review step lets them edit the wording and
 * drop anything they did not want. So this takes the statements at face value
 * rather than re-deriving them, and mem0 only de-duplicates them against what
 * the user already remembers.
 *
 * The owner comes from the session, never the body.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!(await copilotMemoryEnabled())) {
      return NextResponse.json({ error: 'Memory is not enabled' }, { status: 403 });
    }

    const workspaceId = await getActiveWorkspaceId();
    if (!workspaceId) {
      return NextResponse.json({ error: 'No active workspace' }, { status: 400 });
    }

    const body = await req.json();
    if (!Array.isArray(body?.statements)) {
      return NextResponse.json({ error: 'statements must be an array' }, { status: 400 });
    }
    const statements: string[] = body.statements
      .filter((s: unknown): s is string => typeof s === 'string')
      .map((s: string) => s.trim())
      .filter(Boolean);

    if (statements.length === 0) {
      return NextResponse.json(
        { error: 'There is nothing left to save.' },
        { status: 400 },
      );
    }
    if (statements.length > MAX_IMPORT_STATEMENTS) {
      return NextResponse.json(
        { error: `An import may save at most ${MAX_IMPORT_STATEMENTS} memories at once.` },
        { status: 413 },
      );
    }

    const origin =
      typeof body?.origin === 'string' && body.origin.trim() ? body.origin.trim() : undefined;

    const db = createDb();
    const { userMemoryService } = createContainer(db, workspaceId);
    const memory = userMemoryService(userId);

    // Counted around the write rather than taken from mem0's return. mem0
    // swallows its own extraction failures and reports zero records, which is
    // indistinguishable from "everything was a duplicate" unless the store is
    // measured. `added` here is what actually landed.
    const before = await memory.count();
    const result = await memory.saveReviewed({ userId, statements, origin });
    const total = await memory.count();
    const added = Math.max(total - before, 0);

    return NextResponse.json({
      data: {
        submitted: result.submitted,
        added,
        skipped: Math.max(result.submitted - added, 0),
        total,
      },
    });
  } catch (err) {
    if (err instanceof MemoryUnavailableError) {
      return NextResponse.json(
        {
          error:
            'Memory is switched off for your account. Turn on "Remember me across conversations" to import.',
        },
        { status: 409 },
      );
    }
    // Saving is the first point in the import that needs Bedrock and the
    // `user_memories` table, neither of which `memoryConfigured()` checks — so
    // a deployment can extract fine and only fail here. Name the cause when it
    // is one retrying cannot fix.
    const failure = describeMemoryFailure(err);
    console.error(
      `[POST /api/profile/memories/import/confirm] ${failure.permanent ? 'CONFIGURATION' : 'transient'} failure:`,
      err,
    );
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
}
