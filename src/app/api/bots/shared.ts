import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getActiveWorkspaceIdOrThrow, NoActiveWorkspaceError } from '@/lib/workspace';
import {
  BotForbiddenError,
  BotNotFoundError,
  BotValidationError,
} from '@/lib/services/botService';
import { BotRoutineNotFoundError, BotRoutineValidationError } from '@/lib/services/botRoutineService';

/**
 * The gate every /api/bots handler runs first: the caller must be signed in. Returns the caller and workspace, or the response to send.
 */
export async function botRequestContext(): Promise<
  { userId: string; workspaceId: string } | { response: NextResponse }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const workspaceId = await getActiveWorkspaceIdOrThrow();
  return { userId: session.user.id, workspaceId };
}

/** Maps the bot services' typed errors to their HTTP responses. */
export function botErrorResponse(error: unknown, tag: string): NextResponse {
  if (error instanceof NoActiveWorkspaceError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof BotValidationError || error instanceof BotRoutineValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof BotForbiddenError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof BotNotFoundError || error instanceof BotRoutineNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  console.error(tag, error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** A JSON object body, or null for anything else (the caller answers 400). */
export async function readObjectBody(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}
