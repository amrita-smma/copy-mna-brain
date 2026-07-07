import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { auth } from '@/auth';

const FILE_TYPE_OVERRIDES = ['mom', 'prospectus', 'other', 'shopping_list', 'market_study'] as const;
type FileTypeOverrideValue = (typeof FILE_TYPE_OVERRIDES)[number];

function parseFileTypeOverride(value: unknown): FileTypeOverrideValue | undefined {
  if (typeof value !== 'string') return undefined;
  return (FILE_TYPE_OVERRIDES as readonly string[]).includes(value)
    ? (value as FileTypeOverrideValue)
    : undefined;
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

    // For session-authenticated (manual) uploads: use the logged-in user as the enterer.
    const session = await auth();
    const uploaderUserId = session?.user?.id ?? null;

    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
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

    return NextResponse.json({ success: true, data });
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
    // The UI sends `?file_type` (empty string) as the "MoM" sentinel, `?file_type=prospectus|other`
    // to pick a specific bucket, and param-absent to mean "no filter" for non-UI callers.
    const raw = request.nextUrl.searchParams.get("file_type");
    const fileType = raw === "" ? "mom" : (raw ?? undefined);

    const db = createDb();
    const { fileService } = createContainer(db, await getActiveWorkspaceId());
    const data = await fileService.findAll(fileType);
    return NextResponse.json({ success: true, data });
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
