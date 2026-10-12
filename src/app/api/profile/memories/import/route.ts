import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { copilotMemoryEnabled } from '@/lib/flags';
import { extractTextFromFile } from '@/lib/fileExtractor';
import { MemoryImportTooLargeError } from '@/lib/services/userMemoryService';
import { MAX_IMPORT_CHARS } from '@/lib/memory/limits';
import { describeMemoryFailure } from '@/lib/memory/failures';
import { flushLangfuse } from '@/lib/langfuse';

/** Long enough for the agent to read a big paste or document. */
export const maxDuration = 300;

/**
 * Largest file accepted. Comfortably above a long notes export and well below
 * anything that would be slow to extract text from in a request.
 */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Step one of importing memories (Profile → Memory → Import): read a paste or
 * an uploaded file and return what the CoPilot *proposes* remembering.
 *
 * **Nothing is stored here.** The user reviews the proposals, edits or removes
 * any of them, and the survivors go to `./confirm`. An import writes to a store
 * that is read back into unrelated conversations for months, so it is never the
 * side effect of pressing one button.
 *
 * Accepts either JSON (`{ text, origin }`) or multipart form-data (`file`,
 * `origin`). The file's text is extracted server-side with the same
 * `extractTextFromFile` the chat attachments and deal documents use.
 *
 * The content is never interpreted here: it goes to the `@memory_import` agent,
 * which has exactly one tool and cannot write anything.
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

    const parsed = await readImportInput(req);
    if ('error' in parsed) return parsed.error;
    const { text, origin } = parsed;

    if (!text.trim()) {
      return NextResponse.json(
        { error: 'There was nothing to read in that — paste some text or pick another file.' },
        { status: 400 },
      );
    }
    if (text.length > MAX_IMPORT_CHARS) {
      return NextResponse.json(
        {
          error: `That is ${text.length.toLocaleString()} characters; the limit is ${MAX_IMPORT_CHARS.toLocaleString()}. Import it in smaller pieces.`,
        },
        { status: 413 },
      );
    }

    const db = createDb();
    const { userMemoryService } = createContainer(db, workspaceId);
    const memory = userMemoryService(userId);
    if (!memory.available()) {
      return NextResponse.json(
        { error: 'Memory is not configured on this deployment' },
        { status: 503 },
      );
    }
    if (!(await memory.enabledForUser())) {
      return NextResponse.json(
        {
          error:
            'Memory is switched off for your account. Turn on "Remember me across conversations" to import.',
        },
        { status: 409 },
      );
    }

    try {
      const { statements, summary } = await memory.extractForReview({
        userId,
        text,
        origin,
        signal: req.signal,
      });
      return NextResponse.json({ data: { statements, summary, origin: origin ?? null } });
    } finally {
      // Awaited rather than deferred: this request already blocks on the agent
      // run, so the flush costs nothing noticeable, and a failed extraction is
      // exactly the trace worth keeping.
      await flushLangfuse();
    }
  } catch (err) {
    if (err instanceof MemoryImportTooLargeError) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    // Logged in full, reported by class: the provider's own message carries
    // model ids, endpoints and occasionally file contents, but "try again" is
    // wrong for a deployment that is simply not configured.
    const failure = describeMemoryFailure(err);
    console.error(
      `[POST /api/profile/memories/import] ${failure.permanent ? 'CONFIGURATION' : 'transient'} failure:`,
      err,
    );
    return NextResponse.json(
      { error: failure.permanent ? failure.message : 'Could not read that. Please try again.' },
      { status: failure.status },
    );
  }
}

type ImportInput = { text: string; origin?: string };

/**
 * Read the paste or the uploaded file. Returns a ready response on bad input
 * rather than throwing, so the handler stays linear.
 */
async function readImportInput(
  req: NextRequest,
): Promise<ImportInput | { error: NextResponse }> {
  const contentType = req.headers.get('content-type') ?? '';

  if (!contentType.includes('multipart/form-data')) {
    const body = await req.json();
    return {
      text: typeof body?.text === 'string' ? body.text : '',
      origin: typeof body?.origin === 'string' && body.origin.trim() ? body.origin.trim() : undefined,
    };
  }

  const form = await req.formData();
  const file = form.get('file');
  const noteRaw = form.get('origin');
  const note = typeof noteRaw === 'string' && noteRaw.trim() ? noteRaw.trim() : undefined;

  if (!(file instanceof File)) {
    return {
      error: NextResponse.json({ error: 'No file was uploaded' }, { status: 400 }),
    };
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      error: NextResponse.json(
        { error: `That file is larger than ${MAX_FILE_BYTES / (1024 * 1024)}MB.` },
        { status: 413 },
      ),
    };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  let text: string;
  try {
    text = await extractTextFromFile(buffer, file.type, file.name);
  } catch (err) {
    console.error('[POST /api/profile/memories/import] text extraction failed:', err);
    return {
      error: NextResponse.json(
        { error: `Could not read text out of "${file.name}". Try a PDF, Word file, or plain text.` },
        { status: 415 },
      ),
    };
  }

  // The file's own name is the provenance when the user did not write a note,
  // so a memory can always be traced back to what it came from.
  return { text, origin: note ? `${file.name} — ${note}` : file.name };
}
