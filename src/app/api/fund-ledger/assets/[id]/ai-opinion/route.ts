import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/server/db";
import { getActiveWorkspaceId } from "@/lib/workspace";
import {
  createContainer,
  EntityNotFoundError,
  FL_DOMAIN_ERRORS,
  WorkspaceMismatchError,
} from "@/lib/services";

function handleRouteError(error: unknown) {
  if (
    error instanceof EntityNotFoundError ||
    (error instanceof Error && error.name === "EntityNotFoundError")
  ) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (
    error instanceof WorkspaceMismatchError ||
    (error instanceof Error && error.name === "WorkspaceMismatchError")
  ) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (
    FL_DOMAIN_ERRORS.some(
      (cls) =>
        error instanceof cls ||
        (error instanceof Error && error.name === cls.name),
    )
  ) {
    const err = error as Error;
    return NextResponse.json(
      { error: err.message, error_name: err.name },
      { status: 422 },
    );
  }
  const message = error instanceof Error ? error.message : "Internal server error";
  return NextResponse.json({ error: message }, { status: 500 });
}

async function getAuthenticatedUserId(): Promise<string | null> {
  try {
    const { auth } = await import("@/auth");
    const session = await auth();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { fundAiOpinionService } = createContainer(db, workspaceId);
    const userId = await getAuthenticatedUserId();

    const data = await fundAiOpinionService.dispatch(id, userId);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { fundAiOpinionService } = createContainer(db, workspaceId);

    const opinion = await fundAiOpinionService.getOpinion(id);
    return NextResponse.json({ data: { ai_opinion: opinion } });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceId();
    const db = createDb();
    const { fundAiOpinionService } = createContainer(db, workspaceId);

    const data = await fundAiOpinionService.clear(id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return handleRouteError(error);
  }
}
