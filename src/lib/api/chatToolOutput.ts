import { apiRequest } from '@/lib/api/client';

/**
 * One tool call's whole stored output. The transcript holds only its head
 * (`TOOL_OUTPUT_CLIENT_CHARS`); the trace's "Show full output" reads the
 * rest here. Rejects with status 404 until the turn's reply is stored.
 */
export function getToolOutput(
  chatId: string,
  toolCallId: string,
): Promise<{ toolCallId: string; content: string }> {
  return apiRequest<{ toolCallId: string; content: string }>(
    `/api/copilot/chats/${encodeURIComponent(chatId)}/tool-outputs/${encodeURIComponent(toolCallId)}`,
  );
}
