import { NextRequest, NextResponse } from "next/server";
import { getUploadSignedUrl, generateMeetingNoteKey } from "@/lib/s3";

/**
 * GET - Generate a pre-signed URL for direct upload to S3
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const fileName = searchParams.get("fileName");
    const contentType = searchParams.get("contentType") || "application/octet-stream";

    if (!fileName) {
      return NextResponse.json(
        { error: "fileName parameter is required" },
        { status: 400 }
      );
    }

    const s3Key = generateMeetingNoteKey(fileName);
    const uploadUrl = await getUploadSignedUrl(s3Key, contentType);

    return NextResponse.json({
      success: true,
      data: {
        uploadUrl,
        key: s3Key,
      },
    });
  } catch (error) {
    console.error("Error generating upload URL:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to generate upload URL" },
      { status: 500 }
    );
  }
}
