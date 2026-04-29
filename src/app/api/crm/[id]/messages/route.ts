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

    const data = await crmService.getMessagesByContactId(id);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Fetch messages error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to fetch messages" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const { direction, subject, body: messageBody, sent_at, from_email, to_email } = body;

    if (!messageBody) {
      return NextResponse.json(
        { error: "Message body is required" },
        { status: 400 },
      );
    }

    const db = createDb();
    const { crmService } = createContainer(db);

    const data = await crmService.addMessage({
      contact_id: id,
      direction: direction || "inbound",
      subject,
      body: messageBody,
      sent_at,
      from_email,
      to_email,
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Add message error:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to add message" },
      { status: 500 },
    );
  }
}
