import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { MAX_IMPORT_BATCH, sanitizeImportRows } from '@/lib/crm/contactImport';

/**
 * Bulk contact import, one batch per request. Body: `{ contacts:
 * ImportContactRow[] }` — the client parses the CSV/Excel file and posts it in
 * consecutive batches of `IMPORT_BATCH_SIZE`, so the file itself has no row
 * limit; rows are re-validated here. Rows merge into existing contacts by email (see
 * `CRMService.importContacts`).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const contacts = (body as { contacts?: unknown } | null)?.contacts;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return NextResponse.json(
        { error: 'contacts must be a non-empty array' },
        { status: 400 },
      );
    }
    if (contacts.length > MAX_IMPORT_BATCH) {
      return NextResponse.json(
        { error: `At most ${MAX_IMPORT_BATCH} contacts per request — send the file in batches` },
        { status: 400 },
      );
    }
    const { rows, errors } = sanitizeImportRows(contacts);
    const session = await auth();
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const result = await crmService.importContacts(
      rows,
      session?.user?.id ?? null,
    );
    return NextResponse.json({
      data: {
        ...result,
        skipped: result.skipped + (contacts.length - rows.length),
        errors: [...errors, ...result.errors],
      },
    });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
