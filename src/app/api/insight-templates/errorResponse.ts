import { NextResponse } from 'next/server';
import { NoActiveWorkspaceError } from '@/lib/workspace';
import {
  InsightTemplateNotFoundError,
  InsightTemplateTooLargeError,
  InsightTemplateValidationError,
} from '@/lib/services/insightTemplateService';

/** Maps the insight template service's typed errors to their HTTP responses. */
export function insightTemplateErrorResponse(error: unknown, tag: string): NextResponse {
  if (error instanceof NoActiveWorkspaceError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof InsightTemplateValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof InsightTemplateNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof InsightTemplateTooLargeError) {
    return NextResponse.json({ error: error.message }, { status: 413 });
  }
  console.error(tag, error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
