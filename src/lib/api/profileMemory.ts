import { apiRequest } from '@/lib/api/client';
import type { UserMemoryItem } from '@/lib/services/userMemoryService';

export type { UserMemoryItem, UserMemorySource } from '@/lib/services/userMemoryService';

export interface ProfileMemories {
  items: UserMemoryItem[];
  total: number;
  /** True when another page remains past this one. */
  hasMore: boolean;
  /**
   * False when memory is off for the whole deployment (the
   * `COPILOT_MEMORY_ENABLED` kill-switch, or no LLM key). Nothing the user can
   * change, so the tab says so instead of showing a toggle they can't use.
   */
  available: boolean;
  /** The user's own preference. False means they turned memory off. */
  enabled: boolean;
}

/** What `extractProfileMemories` proposes. Nothing is stored until confirmed. */
export interface MemoryImportProposal {
  /** Statements the agent found, for the user to review and edit. */
  statements: string[];
  /** The agent's own one-line account of what it read. */
  summary: string;
  /** Where it came from, carried through to the confirm call. */
  origin: string | null;
}

export interface MemoryImportResult {
  /** Statements submitted after the user's review. */
  submitted: number;
  /** Memories actually written — the rest were already known. */
  added: number;
  skipped: number;
  /** The user's memory count after the import. */
  total: number;
}

/**
 * What the CoPilot remembers about the signed-in user. The endpoint reads the
 * user from the session, so there is nothing to pass but the page window.
 */
export async function getProfileMemories(
  params: { limit?: number; offset?: number } = {},
): Promise<ProfileMemories> {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  const query = search.toString();
  return apiRequest<ProfileMemories>(`/api/profile/memories${query ? `?${query}` : ''}`);
}

/** Turn the CoPilot's memory of this user on or off. Existing memories are kept. */
export async function setProfileMemoryEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
  return apiRequest<{ enabled: boolean }>('/api/profile/memories', {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
}

/** Forget one memory. */
export async function deleteProfileMemory(id: string): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(`/api/profile/memories/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** Forget everything remembered about this user. */
export async function clearProfileMemories(): Promise<{ deleted: number }> {
  return apiRequest<{ deleted: number }>('/api/profile/memories', { method: 'DELETE' });
}

/**
 * Step one: have the import agent read pasted text and propose what to
 * remember. Nothing is stored — the caller shows the proposals for review.
 */
export async function extractProfileMemories(input: {
  text: string;
  origin?: string;
}): Promise<MemoryImportProposal> {
  return apiRequest<MemoryImportProposal>('/api/profile/memories/import', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Step one, from a file. Sent as multipart so the document never has to be
 * base64'd through JSON; the server extracts its text.
 */
export async function extractProfileMemoriesFromFile(input: {
  file: File;
  note?: string;
}): Promise<MemoryImportProposal> {
  const form = new FormData();
  form.append('file', input.file);
  if (input.note) form.append('origin', input.note);
  return apiRequest<MemoryImportProposal>('/api/profile/memories/import', {
    method: 'POST',
    body: form,
  });
}

/**
 * Step two: store the statements the user approved. These may differ from what
 * was proposed — the review step lets them edit and drop entries.
 */
export async function confirmProfileMemories(input: {
  statements: string[];
  origin?: string | null;
}): Promise<MemoryImportResult> {
  return apiRequest<MemoryImportResult>('/api/profile/memories/import/confirm', {
    method: 'POST',
    body: JSON.stringify({ statements: input.statements, origin: input.origin ?? undefined }),
  });
}
