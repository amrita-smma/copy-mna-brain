import { apiRequest } from '@/lib/api/client';
import {
  INSIGHT_TEMPLATE_MAX_CHARS,
  formatTemplateTooLargeMessage,
} from '@/lib/insights/templateAttachment';

export interface InsightTemplateSummary {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  created_by: string | null;
  /** Present on listings; write responses leave it out. */
  created_by_name?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /**
   * How many live (non-archived) insights were created from the template.
   * Present on the live library listing; other responses leave it out.
   */
  usage_count?: number;
}

export interface UploadInsightTemplateParams {
  name: string;
  description?: string | null;
  icon?: string | null;
  /** The file's text, already read and checked by `validateTemplateFile`. */
  html: string;
}

/** The character cap, the same one the server enforces. */
export const MAX_TEMPLATE_CHARS = INSIGHT_TEMPLATE_MAX_CHARS;
// UTF-8 spends at most 3 bytes per UTF-16 code unit, so a file this large
// can't be under the character cap and isn't worth reading.
const MAX_TEMPLATE_FILE_BYTES = MAX_TEMPLATE_CHARS * 3;
export const ALLOWED_TEMPLATE_EXTENSIONS = ['.html'];

export function isValidTemplateExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ALLOWED_TEMPLATE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export type TemplateFileResult =
  | { ok: true; html: string }
  | { ok: false; error: string };

/**
 * Reads a picked template file and applies the upload rules: an `.html` file,
 * not empty, within the character cap. The text is read before it is
 * accepted, because the cap counts characters, not bytes.
 */
export async function validateTemplateFile(file: File): Promise<TemplateFileResult> {
  if (!isValidTemplateExtension(file.name)) {
    return { ok: false, error: 'Invalid file type. Only HTML files are supported.' };
  }
  if (file.size === 0) {
    return { ok: false, error: 'The file is empty.' };
  }
  if (file.size > MAX_TEMPLATE_FILE_BYTES) {
    return {
      ok: false,
      error: `Template is over ${MAX_TEMPLATE_CHARS.toLocaleString('en-US')} characters; templates are limited to ${MAX_TEMPLATE_CHARS.toLocaleString('en-US')}.`,
    };
  }
  const html = await file.text();
  if (!html.trim()) {
    return { ok: false, error: 'The file is empty.' };
  }
  if (html.length > MAX_TEMPLATE_CHARS) {
    return { ok: false, error: formatTemplateTooLargeMessage(html.length) };
  }
  return { ok: true, html };
}

/**
 * Fetch all live insight templates for the active workspace, newest first.
 */
export async function listInsightTemplates(): Promise<InsightTemplateSummary[]> {
  return apiRequest<InsightTemplateSummary[]>('/api/insight-templates');
}

/**
 * Fetch Recently deleted: the soft-deleted templates, newest deletion first.
 */
export async function listDeletedInsightTemplates(): Promise<InsightTemplateSummary[]> {
  return apiRequest<InsightTemplateSummary[]>('/api/insight-templates?deleted=true');
}

/**
 * Fetch a template's rendered HTML, for the hover preview.
 */
export async function getInsightTemplateHtml(id: string): Promise<string> {
  const { html } = await apiRequest<{ html: string }>(
    `/api/insight-templates/${encodeURIComponent(id)}`,
  );
  return html;
}

/**
 * Move an insight template to Recently deleted.
 */
export async function deleteInsightTemplate(
  id: string,
): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(
    `/api/insight-templates/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
    },
  );
}

/**
 * Delete an insight template and its history for good.
 */
export async function deleteInsightTemplatePermanently(
  id: string,
): Promise<{ id: string }> {
  return apiRequest<{ id: string }>(
    `/api/insight-templates/${encodeURIComponent(id)}?permanent=true`,
    {
      method: 'DELETE',
    },
  );
}

/**
 * Bring an insight template back from Recently deleted.
 */
export async function restoreInsightTemplate(
  id: string,
): Promise<InsightTemplateSummary> {
  return apiRequest<InsightTemplateSummary>(
    `/api/insight-templates/${encodeURIComponent(id)}/restore`,
    {
      method: 'POST',
    },
  );
}

/**
 * Upload an insight template: the file's HTML is sent in the request and
 * stored on the template row.
 */
export async function uploadInsightTemplate({
  name,
  description,
  icon,
  html,
}: UploadInsightTemplateParams): Promise<InsightTemplateSummary> {
  return apiRequest<InsightTemplateSummary>('/api/insight-templates', {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: description ?? null,
      icon: icon ?? null,
      html,
    }),
  });
}

/**
 * Replace a template's HTML.
 */
export async function replaceInsightTemplateHtml(
  id: string,
  html: string,
): Promise<InsightTemplateSummary> {
  return apiRequest<InsightTemplateSummary>(
    `/api/insight-templates/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ html }),
    },
  );
}

/**
 * Save an existing insight's HTML as a new insight template.
 */
export async function saveInsightAsTemplate(
  insightId: string,
  params: { name: string; description?: string | null },
): Promise<InsightTemplateSummary> {
  return apiRequest<InsightTemplateSummary>(
    `/api/insights/${encodeURIComponent(insightId)}/save-as-template`,
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  );
}

export interface UpdateInsightTemplateParams {
  name?: string;
  description?: string | null;
  icon?: string | null;
}

/**
 * Update an existing insight template's metadata.
 */
export async function updateInsightTemplate(
  id: string,
  patch: UpdateInsightTemplateParams,
): Promise<InsightTemplateSummary> {
  return apiRequest<InsightTemplateSummary>(
    `/api/insight-templates/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  );
}

/**
 * Duplicate an existing insight template.
 */
export async function duplicateInsightTemplate(
  id: string,
): Promise<InsightTemplateSummary> {
  return apiRequest<InsightTemplateSummary>(
    `/api/insight-templates/${encodeURIComponent(id)}/duplicate`,
    {
      method: 'POST',
    },
  );
}
