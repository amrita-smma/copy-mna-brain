import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { asyncJobId } from '@/lib/services/fileService';
import { auth } from '@/auth';
import {
  UserWorkspaceRepository,
  type FileSortField,
} from '@/lib/repositories';

export const maxDuration = 600;

const FILE_TYPE_OVERRIDES = ['mom', 'prospectus', 'other', 'shopping_list', 'market_study', 'fund_updates'] as const;
type FileTypeOverrideValue = (typeof FILE_TYPE_OVERRIDES)[number];

function parseFileTypeOverride(value: unknown): FileTypeOverrideValue | undefined {
  if (typeof value !== 'string') return undefined;
  return (FILE_TYPE_OVERRIDES as readonly string[]).includes(value)
    ? (value as FileTypeOverrideValue)
    : undefined;
}

const FILE_SORT_FIELDS = ['file_name', 'file_date', 'processing_status', 'created_at'] as const;

function parseSortField(value: string | null): FileSortField | undefined {
  return value && (FILE_SORT_FIELDS as readonly string[]).includes(value)
    ? (value as FileSortField)
    : undefined;
}

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export async function POST(request: NextRequest) {
  try {
    const {
      key,
      fileName,
      contentType,
      raw_notes: userRawNotes,
      file_type_override: rawFileTypeOverride,
      origin_email: rawOriginEmail,
      banker_source: rawBankerSource,
      // For MBOX pipeline: custodian email address to resolve to a user UUID.
      entered_by: rawEnteredByEmail,
      workspace_id: rawWorkspaceId,
    } = await request.json();

    if (!key || !fileName) {
      return NextResponse.json(
        { error: 'key and fileName are required' },
        { status: 400 },
      );
    }

    const fileTypeOverride = parseFileTypeOverride(rawFileTypeOverride);
    const originEmail = rawOriginEmail === true;
    const bankerSource = typeof rawBankerSource === 'string' && rawBankerSource.trim()
      ? rawBankerSource.trim()
      : undefined;
    const enteredByEmail = typeof rawEnteredByEmail === 'string' && rawEnteredByEmail.trim()
      ? rawEnteredByEmail.trim()
      : undefined;
    const requestedWorkspaceId =
      typeof rawWorkspaceId === 'string' && rawWorkspaceId.trim()
        ? rawWorkspaceId.trim()
        : undefined;

    // For session-authenticated (manual) uploads: use the logged-in user as the enterer.
    const session = await auth();
    const uploaderUserId = session?.user?.id ?? null;

    const db = createDb();
    // Internal pipeline calls have no session and authenticate via ADMIN_SECRET;
    // preserve the custodian's workspace instead of falling back to MNA.
    let workspaceId = await getActiveWorkspaceId();
    if (!session && requestedWorkspaceId) {
      if (!enteredByEmail) {
        return NextResponse.json(
          { error: 'entered_by is required with workspace_id' },
          { status: 403 },
        );
      }
      const allowedWorkspaceIds = await new UserWorkspaceRepository(
        db,
      ).findWorkspaceIdsBySyncedEmail(enteredByEmail);
      if (!allowedWorkspaceIds.includes(requestedWorkspaceId)) {
        return NextResponse.json(
          { error: 'Custodian is not synced to the requested workspace' },
          { status: 403 },
        );
      }
      workspaceId = requestedWorkspaceId;
    }
    const { fileService } = createContainer(db, workspaceId);
    const data = await fileService.processUpload(
      key,
      fileName,
      contentType,
      userRawNotes,
      fileTypeOverride,
      originEmail,
      bankerSource,
      enteredByEmail,
      uploaderUserId,
    );

    const isAsync = Boolean(asyncJobId(data));
    return NextResponse.json({ success: true, data }, { status: isAsync ? 202 : 200 });
  } catch (error) {
    console.error('Upload file error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to upload file' },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams;
    // The UI sends `?file_type` (empty string) as the "MoM" sentinel, `?file_type=prospectus|other`
    // to pick a specific bucket, and param-absent to mean "no filter" for non-UI callers.
    const raw = params.get("file_type");
    const fileType = raw === "" ? "mom" : (raw ?? undefined);

    // Search, sort and pagination are all resolved server-side so the view
    // only ever fetches a single page rather than the whole bucket.
    const search = params.get("search") ?? undefined;
    const page = parsePositiveInt(params.get("page"), 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parsePositiveInt(params.get("pageSize"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const sortField = parseSortField(params.get("sortField"));
    const sortDirection = params.get("sortDirection") === "asc" ? "asc" : "desc";
    // Callers that only need name/key (e.g. a search picker) skip S3 signing
    // entirely — signing is a real API round-trip per row that goes unused.
    const lite = params.get("lite") === "true";

    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const { data, total } = await fileService.list({
      fileType,
      search,
      sortField,
      sortDirection,
      limit: pageSize,
      offset: (page - 1) * pageSize,
      skipSignedUrls: lite,
    });
    return NextResponse.json({ success: true, data, total, page, pageSize });
  } catch (error) {
    console.error('Fetch files error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to fetch files' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const { id, ...updates } = await request.json();
    if (!id) {
      return NextResponse.json({ error: 'File ID is required' }, { status: 400 });
    }

    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fileService.update(id, updates);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Update file error:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed to update file record' },
      { status: 500 },
    );
  }
}
