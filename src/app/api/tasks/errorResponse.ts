import { NextResponse } from 'next/server';
import { NoActiveWorkspaceError } from '@/lib/workspace';
import { UserTaskValidationError } from '@/lib/services/userTaskService';

/** Maps the task routes' typed errors to HTTP responses; anything else is a 500. */
export function taskErrorResponse(error: unknown, tag: string): NextResponse {
  if (error instanceof NoActiveWorkspaceError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof UserTaskValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  console.error(tag, error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
