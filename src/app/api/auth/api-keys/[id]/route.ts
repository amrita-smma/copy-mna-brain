import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { ApiKeyNotFoundError } from '@/lib/services/apiKeyService';

/**
 * Single-key management. An **admin** route under `/api/auth/*`, gated by the
 * shared-secret `proxy.ts` middleware (`X-Api-Secret` vs `ADMIN_SECRET`).
 *
 *   GET    /api/auth/api-keys/:id  — fetch one key's metadata
 *   PATCH  /api/auth/api-keys/:id  — update name and/or scopes
 *   DELETE /api/auth/api-keys/:id  — revoke the key (soft delete via revoked_at)
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const db = createDb();
    const { apiKeyService } = createContainer(db, await getActiveWorkspaceId());
    const data = await apiKeyService.get(id);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof ApiKeyNotFoundError) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const body = await req.json().catch(() => undefined);
    const fields: { name?: string; scopes?: string[] } = {};

    if (body?.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0) {
        return NextResponse.json(
          { error: 'name must be a non-empty string' },
          { status: 400 },
        );
      }
      fields.name = body.name.trim();
    }
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
      fields.scopes = body.scopes;
    }
    if (fields.name === undefined && fields.scopes === undefined) {
      return NextResponse.json(
        { error: 'provide at least one of: name, scopes' },
        { status: 400 },
      );
    }

    const db = createDb();
    const { apiKeyService } = createContainer(db, await getActiveWorkspaceId());
    const data = await apiKeyService.update(id, fields);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof ApiKeyNotFoundError) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const db = createDb();
    const { apiKeyService } = createContainer(db, await getActiveWorkspaceId());
    const data = await apiKeyService.revoke(id);
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof ApiKeyNotFoundError) {
      return NextResponse.json({ error: 'API key not found' }, { status: 404 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
