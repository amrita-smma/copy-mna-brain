import Anthropic, { toFile } from '@anthropic-ai/sdk';
import {
  chatAttachmentPrefix,
  deleteFile,
  downloadFile,
  generateChatAttachmentKey,
  getUploadSignedUrl,
} from '@/lib/s3';
import { extractTextFromFile } from '@/lib/fileExtractor';
import { formatLargeHtmlAttachmentBlock, isHtmlAttachment } from '@/lib/insights/largeDocument';
import { isTooLargeForChat } from '@/lib/insights/templateAttachment';

/**
 * Beta flag required for the Files API. Both the upload/delete calls and any
 * message that references an uploaded file by id must carry this header.
 */
const FILES_API_BETA = 'files-api-2025-04-14' as const;

/** A chat attachment as the client references it: an S3 key + display metadata. */
export interface ChatAttachmentRef {
  key: string;
  fileName: string;
  contentType: string;
}

export function isChatAttachmentRef(v: unknown): v is ChatAttachmentRef {
  return Boolean(
    v &&
      typeof v === 'object' &&
      typeof (v as ChatAttachmentRef).key === 'string' &&
      typeof (v as ChatAttachmentRef).fileName === 'string' &&
      typeof (v as ChatAttachmentRef).contentType === 'string',
  );
}

export interface ChatAttachmentUploadTarget {
  uploadUrl: string;
  key: string;
}

/** A content block ready to drop into a HumanMessage `content` array. */
export type AttachmentContentBlock =
  | { type: 'file'; fileId: string }
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface PreparedAttachments {
  /** Content blocks to append after the user's text. */
  blocks: AttachmentContentBlock[];
  /** Anthropic Files API ids that must be deleted once the turn settles. */
  fileIds: string[];
  /**
   * File names of HTML attachments sent as an outline (plus the Workforce
   * handoff rule) instead of their text, because they are too large for chat.
   * Always empty in `'full'` mode.
   */
  outlinedHtml: string[];
}

export interface PrepareAttachmentsOptions {
  /**
   * What an HTML attachment larger than CHAT_INLINE_DOCUMENT_MAX_CHARS
   * becomes. Chat passes `'outline'`: an outline of its sections plus a hard
   * instruction to hand the work to the Workforce, because one chat turn
   * cannot write a document that size. The Workforce passes `'full'`: it
   * builds section by section and needs the whole file. Required, so neither
   * caller gets the other's behaviour by default.
   */
  largeHtml: 'outline' | 'full';
}

/**
 * Media types Claude reads directly as a Files-API document/image reference.
 * Anything else is rejected by the API ("Only PDF and plaintext documents are
 * supported"), so those files are text-extracted and inlined instead. Falls
 * back to the filename extension when the browser sends a vague content type.
 */
function nativeMediaType(contentType: string, fileName: string): string | null {
  const ct = (contentType || '').toLowerCase();
  const name = fileName.toLowerCase();
  if (ct === 'application/pdf' || name.endsWith('.pdf')) return 'application/pdf';
  if (ct === 'image/png' || name.endsWith('.png')) return 'image/png';
  if (ct === 'image/jpeg' || name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (ct === 'image/gif' || name.endsWith('.gif')) return 'image/gif';
  if (ct === 'image/webp' || name.endsWith('.webp')) return 'image/webp';
  return null;
}

/**
 * Raised when a request references a chat-attachment S3 key that does not
 * belong to the active workspace (a spoofed key, another tenant's file, or a
 * key from an unrelated prefix such as `meeting-notes/`).
 */
export class ChatAttachmentForbiddenError extends Error {
  constructor(message = 'Attachment does not belong to this workspace') {
    super(message);
    this.name = 'ChatAttachmentForbiddenError';
  }
}

/**
 * Manages the lifecycle of copilot chat attachments.
 *
 * These files are stored plainly in S3 under `chat-attachments/{workspaceId}/`
 * — they are deliberately NOT part of the Smart Files `files` table and never
 * run through the extraction pipeline. The S3 object is the durable store: it
 * persists so the file can be re-referenced on every turn of the chat. On each
 * send, the file is uploaded to Anthropic's Files API for that one request and
 * deleted again once the turn finishes (or is stopped / disconnected).
 */
export class ChatAttachmentService {
  constructor(
    private readonly workspaceId: string,
    private readonly apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
  ) {}

  private prefix(): string {
    return chatAttachmentPrefix(this.workspaceId);
  }

  /**
   * Guard: a request may only touch keys under its own workspace's prefix.
   * Prevents referencing another tenant's attachments or non-chat S3 objects.
   */
  private assertOwned(key: string): void {
    if (!key.startsWith(this.prefix())) {
      throw new ChatAttachmentForbiddenError();
    }
  }

  /**
   * The well-formed refs among `values` whose key is under this workspace's
   * prefix — the same ownership rule `prepareForMessage` enforces. Used for
   * refs read back from a thread's history: anything else is dropped rather
   * than thrown on, so a bad entry in history can never block a later turn.
   */
  ownedRefs(values: unknown): ChatAttachmentRef[] {
    if (!Array.isArray(values)) return [];
    const prefix = this.prefix();
    return values
      .filter(isChatAttachmentRef)
      .filter((ref) => ref.key.startsWith(prefix))
      .map(({ key, fileName, contentType }) => ({ key, fileName, contentType }));
  }

  private anthropic(): Anthropic {
    if (!this.apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    return new Anthropic({ apiKey: this.apiKey });
  }

  /**
   * Mint a presigned PUT URL so the browser can upload the file directly to
   * S3. Returns the URL and the generated key the client should later send
   * with its chat message.
   */
  async createUploadTarget(
    fileName: string,
    contentType: string,
  ): Promise<ChatAttachmentUploadTarget> {
    const key = generateChatAttachmentKey(this.workspaceId, fileName);
    const uploadUrl = await getUploadSignedUrl(key, contentType);
    return { uploadUrl, key };
  }

  /** Delete a chat attachment from S3 (e.g. user removed the chip / new chat). */
  async delete(key: string): Promise<void> {
    this.assertOwned(key);
    await deleteFile(key);
  }

  /**
   * Turn each attachment into a message content block. PDFs and images are
   * uploaded to Anthropic's Files API and referenced by id; every other file
   * type is text-extracted (`extractTextFromFile` handles docx/pptx/xlsx/csv/
   * json/text) and inlined as a labelled text block — so ANY uploaded file can
   * be sent without tripping the Files API's format restriction. An HTML file
   * over CHAT_INLINE_DOCUMENT_MAX_CHARS follows `options.largeHtml`. On
   * failure, best-effort deletes whatever was already uploaded so nothing is
   * orphaned.
   */
  async prepareForMessage(
    attachments: ChatAttachmentRef[],
    options: PrepareAttachmentsOptions,
  ): Promise<PreparedAttachments> {
    const blocks: AttachmentContentBlock[] = [];
    const fileIds: string[] = [];
    const outlinedHtml: string[] = [];
    if (attachments.length === 0) return { blocks, fileIds, outlinedHtml };
    const anthropic = this.anthropic();
    try {
      for (const att of attachments) {
        this.assertOwned(att.key);
        const buffer = await downloadFile(att.key);
        const native = nativeMediaType(att.contentType, att.fileName);
        if (native === 'application/pdf') {
          const file = await anthropic.beta.files.upload({
            file: await toFile(buffer, att.fileName, { type: native }),
            betas: [FILES_API_BETA],
          });
          fileIds.push(file.id);
          blocks.push({ type: 'file', fileId: file.id });
        } else if (native && native.startsWith('image/')) {
          const base64 = buffer.toString('base64');
          blocks.push({
            type: 'image_url',
            image_url: { url: `data:${native};base64,${base64}` },
          });
        } else {
          let text: string;
          try {
            text = await extractTextFromFile(buffer, att.contentType, att.fileName);
          } catch (err) {
            blocks.push({
              type: 'text',
              text: `Attached file "${att.fileName}":\n\n[Unable to read this file: ${(err as Error).message}]`,
            });
            continue;
          }
          if (
            options.largeHtml === 'outline' &&
            isHtmlAttachment(att.contentType, att.fileName) &&
            isTooLargeForChat(text)
          ) {
            outlinedHtml.push(att.fileName);
            blocks.push({ type: 'text', text: formatLargeHtmlAttachmentBlock(att.fileName, text) });
            continue;
          }
          blocks.push({ type: 'text', text: `Attached file "${att.fileName}":\n\n${text}` });
        }
      }
      return { blocks, fileIds, outlinedHtml };
    } catch (err) {
      await this.deleteFromAnthropic(fileIds);
      throw err;
    }
  }

  /**
   * Best-effort delete of Anthropic Files API uploads. A failed delete is
   * logged but never thrown — cleanup must not fail the request it runs in.
   */
  async deleteFromAnthropic(fileIds: string[]): Promise<void> {
    if (fileIds.length === 0) return;
    const anthropic = this.anthropic();
    await Promise.all(
      fileIds.map(async (id) => {
        try {
          await anthropic.beta.files.delete(id, { betas: [FILES_API_BETA] });
        } catch (err) {
          console.error(
            `[chat-attachment] failed to delete Anthropic file ${id}:`,
            err,
          );
        }
      }),
    );
  }
}
