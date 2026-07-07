import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

/**
 * Management API for external chat API keys. These are **admin** actions and
 * live under `/api/auth/*`, so they are gated by the shared-secret `proxy.ts`
 * middleware (the `X-Api-Secret` header is compared against `ADMIN_SECRET`) —
 * not by a NextAuth session and not by a chat API key. The minted token is
 * returned exactly once on create and is never retrievable afterwards;
 * list/get expose metadata only.
 *
 *   GET  /api/auth/api-keys        — list all keys (no secrets)
 *   POST /api/auth/api-keys        — mint a new key, returns the raw token once
 */
export async function GET() {
  try {
    const db = createDb();
    const { apiKeyService } = createContainer(db, await getActiveWorkspaceId());
    const data = await apiKeyService.list();
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => undefined);
    const name = body?.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    let scopes: string[] | undefined;
    if (body?.scopes !== undefined) {
      if (
        !Array.isArray(body.scopes) ||
        !body.scopes.every((s: unknown) => typeof s === 'string')
      ) {
        return NextResponse.json(
          { error: 'scopes must be an array of strings' },
          { status: 400 },
        );
      }
      scopes = body.scopes;
    }

    const db = createDb();
    const { apiKeyService } = createContainer(db, await getActiveWorkspaceId());
    const { token, key } = await apiKeyService.issue({ name: name.trim(), scopes });

    // `token` is returned only here — surface it explicitly so callers know to save it.
    return NextResponse.json({ data: { ...key, token } }, { status: 201 });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
