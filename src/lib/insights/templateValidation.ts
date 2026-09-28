/**
 * The field rules for an insight template's name, HTML and icon. Pure and
 * client-safe, so the service, the Copilot proposal tool and the approval card
 * all apply the same rules. Each returns the error message, or null when the
 * value passes; the service turns a message into its typed error.
 */

import { MAX_INSIGHT_NAME_LENGTH } from '@/lib/insights/toolValidation';
import { isInsightTemplateIcon } from '@/lib/insights/templateIcons';
import {
  INSIGHT_TEMPLATE_MAX_CHARS,
  formatTemplateTooLargeMessage,
} from '@/lib/insights/templateAttachment';

export const TEMPLATE_NAME_REQUIRED_MESSAGE = 'Template name is required';
export const TEMPLATE_HTML_REQUIRED_MESSAGE = 'Template HTML is required';
export const INVALID_TEMPLATE_ICON_MESSAGE = 'Invalid template icon';

/** Why a template name fails, or null. The name is judged trimmed. */
export function templateNameError(name: unknown): string | null {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return TEMPLATE_NAME_REQUIRED_MESSAGE;
  if (trimmed.length > MAX_INSIGHT_NAME_LENGTH) {
    return `Template name exceeds maximum length of ${MAX_INSIGHT_NAME_LENGTH} characters`;
  }
  return null;
}

/** True when `html` is a string over the template character cap. */
export function isTemplateHtmlTooLarge(html: unknown): html is string {
  return typeof html === 'string' && html.length > INSIGHT_TEMPLATE_MAX_CHARS;
}

/**
 * Why template HTML fails, or null: blank, or over the character cap
 * (`html.length`, with the shared size message).
 */
export function templateHtmlError(html: unknown): string | null {
  if (typeof html !== 'string' || !html.trim()) return TEMPLATE_HTML_REQUIRED_MESSAGE;
  if (isTemplateHtmlTooLarge(html)) return formatTemplateTooLargeMessage(html.length);
  return null;
}

/**
 * Why a template icon fails, or null. No icon (null, undefined or '') passes;
 * anything else must be a known icon key.
 */
export function templateIconError(icon: unknown): string | null {
  if (icon === null || icon === undefined || icon === '') return null;
  return isInsightTemplateIcon(icon) ? null : INVALID_TEMPLATE_ICON_MESSAGE;
}
