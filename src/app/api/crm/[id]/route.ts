import { NextRequest, NextResponse } from "next/server";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;

    const db = createDb();
    const { crmService } = createContainer(db);

    const data = await crmService.findContactById(id);

    if (!data) {
      return NextResponse.json(
        { error: "Contact not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Fetch contact error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to fetch contact" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json();

    const db = createDb();
    const { crmService } = createContainer(db);

    const data = await crmService.updateContact(id, body);

    if (!data) {
      return NextResponse.json(
        { error: "Contact not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Update contact error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to update contact" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;

    const db = createDb();
    const { crmService } = createContainer(db);

    await crmService.deleteContact(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete contact error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to delete contact" },
      { status: 500 },
    );
  }
}
