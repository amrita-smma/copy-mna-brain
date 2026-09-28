import { NextResponse } from 'next/server';
import { NoActiveWorkspaceError } from '@/lib/workspace';
import {
  DuplicateInsightRoutineError,
  RoutineAgentPausedError,
  RoutineInsightNotFoundError,
  RoutineNotFoundError,
  RoutineValidationError,
  SystemRoutineError,
} from '@/lib/services/routineService';

/** Maps the routine service's typed errors to their HTTP responses. */
export function routineErrorResponse(error: unknown, tag: string): NextResponse {
  if (error instanceof NoActiveWorkspaceError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof RoutineNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof SystemRoutineError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof RoutineInsightNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof DuplicateInsightRoutineError) {
    return NextResponse.json(
      { error: error.message, insightId: error.insightId },
      { status: 409 },
    );
  }
  if (error instanceof RoutineAgentPausedError) {
    return NextResponse.json(
      { error: error.message, pausedReason: error.reason },
      { status: 409 },
    );
  }
  if (error instanceof RoutineValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error(tag, error);
  // The typed service errors are mapped above. Anything reaching here is
  // unexpected, so it is logged rather than echoed back to the caller.
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
