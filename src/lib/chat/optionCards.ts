/**
 * Option cards: clickable choices a bot offers instead of listing options in
 * prose (`offer_options`). Single choice sends on click; multi choice sends
 * the ticked options; a custom answer lets the user type their own. The pick
 * comes back as an ordinary user message (`optionAnswerText`), so the bot
 * reads it like anything else the user wrote.
 *
 * Pure and client-safe: the tool validates with it and the card renders from
 * it.
 */

export const OPTION_CARD_MARKER = 'OPTION_CARD_JSON';

export const OPTION_CARD_MIN_OPTIONS = 2;
export const OPTION_CARD_MAX_OPTIONS = 6;
export const OPTION_LABEL_MAX_LENGTH = 80;
export const OPTION_DESCRIPTION_MAX_LENGTH = 160;
export const OPTION_QUESTION_MAX_LENGTH = 200;

export type OptionCardMode = 'single' | 'multi';

export interface OptionCardOption {
  label: string;
  /** One line under the label: what picking it means. */
  description?: string;
  /** The bot's own pick; shown with a "Recommended" tag. At most one. */
  recommended?: boolean;
}

export interface OptionCardPayload {
  card_id: string;
  question: string;
  mode: OptionCardMode;
  options: OptionCardOption[];
  /** Offer a free-text answer under the options. */
  allow_custom: boolean;
}

export class OptionCardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionCardValidationError';
  }
}

/** The card as stored and rendered, or a validation error the tool reports back. */
export function buildOptionCard(input: {
  card_id: string;
  question: string;
  mode?: OptionCardMode;
  options: OptionCardOption[];
  allow_custom?: boolean;
}): OptionCardPayload {
  const question = input.question.trim();
  if (!question) throw new OptionCardValidationError('The question is empty');
  if (question.length > OPTION_QUESTION_MAX_LENGTH) {
    throw new OptionCardValidationError(`Keep the question under ${OPTION_QUESTION_MAX_LENGTH} characters`);
  }
  const options: OptionCardOption[] = [];
  for (const raw of input.options) {
    const label = raw.label.trim();
    if (!label) continue;
    if (label.length > OPTION_LABEL_MAX_LENGTH) {
      throw new OptionCardValidationError(`Option "${label.slice(0, 30)}…" is too long; keep labels under ${OPTION_LABEL_MAX_LENGTH} characters`);
    }
    if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) continue;
    const description = raw.description?.trim().slice(0, OPTION_DESCRIPTION_MAX_LENGTH);
    options.push({ label, ...(description ? { description } : {}), ...(raw.recommended ? { recommended: true } : {}) });
  }
  if (options.length < OPTION_CARD_MIN_OPTIONS || options.length > OPTION_CARD_MAX_OPTIONS) {
    throw new OptionCardValidationError(
      `Offer ${OPTION_CARD_MIN_OPTIONS}–${OPTION_CARD_MAX_OPTIONS} distinct options (got ${options.length})`,
    );
  }
  if (options.filter((o) => o.recommended).length > 1) {
    throw new OptionCardValidationError('Recommend at most one option');
  }
  return {
    card_id: input.card_id,
    question,
    mode: input.mode === 'multi' ? 'multi' : 'single',
    options,
    allow_custom: input.allow_custom ?? true,
  };
}

export function isOptionCardPayload(v: unknown): v is OptionCardPayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Partial<OptionCardPayload>;
  return (
    typeof p.card_id === 'string' &&
    typeof p.question === 'string' &&
    (p.mode === 'single' || p.mode === 'multi') &&
    Array.isArray(p.options) &&
    p.options.length >= OPTION_CARD_MIN_OPTIONS &&
    p.options.every((o) => typeof o?.label === 'string') &&
    typeof p.allow_custom === 'boolean'
  );
}

/**
 * The user message a pick sends: the chosen labels (and any custom answer),
 * worded so the bot can tell which card it answers.
 */
export function optionAnswerText(card: Pick<OptionCardPayload, 'question'>, picked: string[], custom?: string): string {
  const answers = [...picked.map((p) => p.trim()).filter(Boolean)];
  const own = custom?.trim();
  if (own) answers.push(own);
  if (answers.length === 0) return '';
  if (answers.length === 1) return `${card.question}\n→ ${answers[0]}`;
  return `${card.question}\n${answers.map((a) => `→ ${a}`).join('\n')}`;
}
