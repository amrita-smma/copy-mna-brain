import { NextResponse } from 'next/server';
import { NoActiveWorkspaceError } from '@/lib/workspace';
import {
  InsightNotFoundError,
  InsightPayloadTooLargeError,
  InsightValidationError,
  StaleInsightVersionError,
} from '@/lib/services/insightService';

/** Maps the insight service's typed errors to their HTTP responses. */
export function insightErrorResponse(error: unknown, tag: string): NextResponse {
  if (error instanceof NoActiveWorkspaceError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof InsightNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof InsightValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof InsightPayloadTooLargeError) {
    return NextResponse.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof StaleInsightVersionError) {
    return NextResponse.json(
      {
        error: error.message,
        baseVersionNo: error.baseVersionNo,
        currentVersionNo: error.currentVersionNo,
      },
      { status: 409 },
    );
  }
  console.error(tag, error);
  // The typed service errors are mapped above. Anything reaching here is
  // unexpected, so it is logged rather than echoed back to the caller.
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
