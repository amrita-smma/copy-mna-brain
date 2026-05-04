import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

const FILE_TYPE_OVERRIDES = ['mom', 'prospectus', 'other'] as const;
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
    } = await request.json();

    if (!key || !fileName) {
      return NextResponse.json(
        { error: 'key and fileName are required' },
        { status: 400 },
      );
    }

    const fileTypeOverride = parseFileTypeOverride(rawFileTypeOverride);

    const db = createDb();
    const { fileService } = createContainer(db);
    const data = await fileService.processUpload(
      key,
      fileName,
      contentType,
      userRawNotes,
      fileTypeOverride,
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
    const { fileService } = createContainer(db);
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
    const { fileService } = createContainer(db);
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
