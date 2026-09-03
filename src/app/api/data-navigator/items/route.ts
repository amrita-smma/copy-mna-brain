import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { RSS_CATEGORIES } from '@/lib/db/schema';
import type { RssCategory } from '@/lib/db/schema';

/**
 * The Data Navigator feed. Session-gated by the proxy middleware like every
 * other `/api/*` route; the underlying data is global, not workspace-scoped.
 */
export async function GET(req: NextRequest) {
  try {
    const params = req.nextUrl.searchParams;

    const cursorId = params.get('cursorId');
    const cursorPublishedAt = params.get('cursorPublishedAt');

    const db = createDb();
    const { dataNavigatorService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dataNavigatorService.listItems({
      categories: splitEnum<RssCategory>(params.get('category'), RSS_CATEGORIES),
      sourceNames: splitList(params.get('source')),
      regions: splitList(params.get('region')),
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      selectedOnly: params.get('selectedOnly') === 'true',
      limit: params.get('limit') ? Number(params.get('limit')) : undefined,
      cursor: cursorId ? { id: cursorId, publishedAt: cursorPublishedAt } : undefined,
    });

    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch news items' }, { status: 500 });
  }
}

function splitList(raw: string | null): string[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((v) => v.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function splitEnum<T extends string>(
  raw: string | null,
  allowed: readonly string[],
): T[] | undefined {
  const values = splitList(raw);
  if (!values) return undefined;
  const filtered = values.filter((v) => allowed.includes(v)) as T[];
  // All-invalid input must not silently widen to "everything".
  return filtered.length > 0 ? filtered : ([] as T[]);
}
