import type {
  InsightTemplate,
  InsightTemplateListItem,
  InsightTemplateRepository,
} from '@/lib/repositories';
import type { InsightRepository } from '@/lib/repositories/insightRepository';
import { duplicateInsightName } from '@/lib/insights/duplicateName';
import { MAX_INSIGHT_NAME_LENGTH } from '@/lib/insights/toolValidation';
import { isInsightTemplateIcon } from '@/lib/insights/templateIcons';
import {
  formatMissingInsightTemplateBlock,
  formatTemplateTooLargeMessage,
  type InsightTemplateAttachment,
} from '@/lib/insights/templateAttachment';
import {
  formatInsightTemplateBlock,
  formatInsightTemplatePart,
} from '@/lib/insights/largeDocument';
import {
  INVALID_TEMPLATE_ICON_MESSAGE,
  isTemplateHtmlTooLarge,
  templateHtmlError,
  templateIconError,
  templateNameError,
} from '@/lib/insights/templateValidation';

export class InsightTemplateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsightTemplateValidationError';
  }
}

export class InsightTemplateNotFoundError extends Error {
  constructor(message = 'Insight template not found') {
    super(message);
    this.name = 'InsightTemplateNotFoundError';
  }
}

export class InsightTemplateTooLargeError extends Error {
  /**
   * `chars` is the rejected HTML's `length`; `hint`, when given, follows the
   * size message and names what the user can do instead.
   */
  constructor(chars: number, hint?: string) {
    super(hint ? `${formatTemplateTooLargeMessage(chars)} ${hint}` : formatTemplateTooLargeMessage(chars));
    this.name = 'InsightTemplateTooLargeError';
  }
}

/** Follows the size refusal when an insight is saved as a template. */
export const SAVE_AS_TEMPLATE_TOO_LARGE_HINT =
  'Trim the insight, then save it as a template again.';

/**
 * The HTML, or a typed error when it is blank or over the character cap.
 * `tooLargeHint` is appended to the size refusal.
 */
function validateTemplateHtml(html: unknown, tooLargeHint?: string): string {
  const error = templateHtmlError(html);
  if (error) {
    if (isTemplateHtmlTooLarge(html)) {
      throw new InsightTemplateTooLargeError(html.length, tooLargeHint);
    }
    throw new InsightTemplateValidationError(error);
  }
  return html as string;
}

/** Trimmed template name, or a validation error when blank or over the
 *  insight name cap (the same cap `duplicateInsightName` truncates to). */
function validateTemplateName(name: unknown): string {
  const error = templateNameError(name);
  if (error) {
    throw new InsightTemplateValidationError(error);
  }
  return (name as string).trim();
}

function normalizeDescription(description: unknown): string | null {
  return typeof description === 'string' && description.trim() ? description.trim() : null;
}

/** A known icon key, null for none, or a validation error. */
function validateTemplateIcon(icon: unknown): string | null {
  const error = templateIconError(icon);
  if (error) {
    throw new InsightTemplateValidationError(error);
  }
  return isInsightTemplateIcon(icon) ? icon : null;
}

export interface CreateInsightTemplateServiceInput {
  name: string;
  description?: string | null;
  icon?: string | null;
  html: string;
  userId?: string | null;
}

export interface CreateInsightTemplateFromInsightInput {
  name: string;
  description?: string | null;
  html: string;
  userId?: string | null;
}

export interface UpdateInsightTemplateInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  html?: string;
}

/** A library row: the listing row plus how many live insights came from it. */
export type InsightTemplateLibraryItem = InsightTemplateListItem & { usage_count: number };

/** The insights read behind the library's usage counts. */
export type InsightTemplateUsageCounter = Pick<InsightRepository, 'countBySourceTemplate'>;

export class InsightTemplateService {
  constructor(
    private readonly repo: InsightTemplateRepository,
    private readonly insightRepo: InsightTemplateUsageCounter,
    private readonly workspaceId: string,
  ) {}

  /**
   * The live library, each template with `usage_count`: how many non-archived
   * insights came from it. Two queries whatever the template count — the
   * listing and one grouped count — merged in one pass.
   */
  async list(): Promise<InsightTemplateLibraryItem[]> {
    const [templates, counts] = await Promise.all([
      this.repo.list(),
      this.insightRepo.countBySourceTemplate(this.workspaceId),
    ]);
    const usage = new Map(counts.map((c) => [c.template_id, c.usage_count]));
    return templates.map((t) => ({ ...t, usage_count: usage.get(t.id) ?? 0 }));
  }

  /** Recently deleted: the soft-deleted templates, newest deletion first. */
  async listDeleted(): Promise<InsightTemplateListItem[]> {
    return this.repo.listDeleted();
  }

  /** The template's current HTML. A soft-deleted template is not found. */
  async getHtml(id: string): Promise<string> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new InsightTemplateNotFoundError();
    }
    return row.html;
  }

  /**
   * The model-facing content block for a template attached to a chat message.
   * Never throws for a template that is gone — a deleted (or soft-deleted)
   * row becomes a "could not be loaded" block so the turn still runs and the
   * model can tell the user.
   */
  async prepareForMessage(
    attachment: InsightTemplateAttachment,
  ): Promise<{ type: 'text'; text: string }> {
    const row = await this.repo.findById(attachment.id);
    if (!row) {
      return { type: 'text', text: formatMissingInsightTemplateBlock(attachment) };
    }
    return { type: 'text', text: formatInsightTemplateBlock(row, row.html) };
  }

  /**
   * One part of a template's full HTML, for a Workforce run, which reads a
   * template of any size in consecutive parts (`part` is 1-based). A template
   * that is gone gets the same "could not be loaded" block as in chat.
   */
  async readPartForWorkforce(
    attachment: InsightTemplateAttachment,
    part: number,
  ): Promise<{ type: 'text'; text: string }> {
    const row = await this.repo.findById(attachment.id);
    if (!row) {
      return { type: 'text', text: formatMissingInsightTemplateBlock(attachment) };
    }
    return { type: 'text', text: formatInsightTemplatePart(row, row.html, part) };
  }

  async create({
    name,
    description,
    icon,
    html,
    userId,
  }: CreateInsightTemplateServiceInput): Promise<InsightTemplate> {
    return this.repo.insert({
      name: validateTemplateName(name),
      description: normalizeDescription(description),
      icon: validateTemplateIcon(icon),
      html: validateTemplateHtml(html),
      created_by: userId ?? null,
    });
  }

  async createFromInsight({
    name,
    description,
    html,
    userId,
  }: CreateInsightTemplateFromInsightInput): Promise<InsightTemplate> {
    const trimmedName = validateTemplateName(name);
    const validHtml = validateTemplateHtml(html, SAVE_AS_TEMPLATE_TOO_LARGE_HINT);

    const existing = await this.repo.list();
    const hasCollision = existing.some((t) => t.name.trim() === trimmedName);
    const finalName = hasCollision
      ? duplicateInsightName(
          trimmedName,
          existing.map((t) => t.name),
          MAX_INSIGHT_NAME_LENGTH,
        )
      : trimmedName;

    return this.repo.insert({
      name: finalName,
      description: normalizeDescription(description),
      html: validHtml,
      created_by: userId ?? null,
    });
  }

  /** Moves the template to Recently deleted. */
  async delete(id: string): Promise<InsightTemplate> {
    const row = await this.repo.softDelete(id);
    if (!row) {
      throw new InsightTemplateNotFoundError();
    }
    return row;
  }

  /** Brings a template back from Recently deleted. */
  async restore(id: string): Promise<InsightTemplate> {
    const row = await this.repo.restore(id);
    if (!row) {
      throw new InsightTemplateNotFoundError();
    }
    return row;
  }

  /** Removes the template for good. */
  async deletePermanently(id: string): Promise<InsightTemplate> {
    const row = await this.repo.hardDelete(id);
    if (!row) {
      throw new InsightTemplateNotFoundError();
    }
    return row;
  }

  async update(
    id: string,
    patchInput: UpdateInsightTemplateInput,
  ): Promise<InsightTemplate> {
    // Only these keys reach the repository.
    const patch: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      html?: string;
    } = {};

    if ('name' in patchInput) {
      patch.name = validateTemplateName(patchInput.name);
    }

    if ('description' in patchInput) {
      patch.description = normalizeDescription(patchInput.description);
    }

    if ('icon' in patchInput) {
      if (patchInput.icon === null) {
        patch.icon = null;
      } else if (isInsightTemplateIcon(patchInput.icon)) {
        patch.icon = patchInput.icon;
      } else {
        throw new InsightTemplateValidationError(INVALID_TEMPLATE_ICON_MESSAGE);
      }
    }

    if ('html' in patchInput) {
      patch.html = validateTemplateHtml(patchInput.html);
    }

    const updated = await this.repo.update(id, patch);
    if (!updated) {
      throw new InsightTemplateNotFoundError();
    }
    return updated;
  }

  async duplicate(id: string, userId?: string | null): Promise<InsightTemplate> {
    const source = await this.repo.findById(id);
    if (!source) {
      throw new InsightTemplateNotFoundError();
    }
    const html = validateTemplateHtml(source.html);

    const existing = await this.repo.list();
    const newName = duplicateInsightName(
      source.name,
      existing.map((t) => t.name),
      MAX_INSIGHT_NAME_LENGTH,
    );

    return this.repo.insert({
      name: newName,
      description: source.description,
      icon: source.icon,
      html,
      created_by: userId ?? null,
    });
  }
}
