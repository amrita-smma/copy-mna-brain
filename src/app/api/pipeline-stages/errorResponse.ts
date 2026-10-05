import { NextResponse } from 'next/server';
import { NoActiveWorkspaceError } from '@/lib/workspace';
import {
  CompanyDroppedError,
  PipelineStageUnavailableError,
} from '@/lib/services/companyService';
import {
  PipelineStageLockedError,
  PipelineStageNotFoundError,
  PipelineStageValidationError,
} from '@/lib/services/pipelineStageService';

/** Maps the pipeline stage service's typed errors to their HTTP responses. */
export function pipelineStageErrorResponse(error: unknown, tag: string): NextResponse {
  if (error instanceof NoActiveWorkspaceError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof PipelineStageValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof PipelineStageNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (
    error instanceof PipelineStageLockedError ||
    error instanceof PipelineStageUnavailableError ||
    error instanceof CompanyDroppedError
  ) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  console.error(tag, error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
