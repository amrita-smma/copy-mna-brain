/**
 * The Deal Pipeline page heading, which each workspace can rename in place.
 *
 * Dependency-free on purpose: the server (route validation, `WorkspaceService`)
 * and the client (the `/w/[slug]` layout provider, the edit dialog) all share
 * these defaults and limits, so the same copy and the same rules apply on both
 * sides without pulling the DB or the agent stack into a client bundle.
 *
 * A stored `null` means "use the product default" — that is what every
 * workspace starts as, and what clearing a field goes back to.
 */

export const DEFAULT_PIPELINE_TITLE = 'Deal Pipeline';
export const DEFAULT_PIPELINE_SUBTITLE = 'Track companies through all stages';

/** Kept short enough to stay on one line next to the Configure button. */
export const PIPELINE_TITLE_MAX_LENGTH = 80;
export const PIPELINE_SUBTITLE_MAX_LENGTH = 160;

/** The heading as rendered — always resolved, never null. */
export interface PipelineHeading {
  title: string;
  subtitle: string;
}

/** The heading as stored — null on either field means "the default". */
export interface PipelineHeadingInput {
  title: string | null;
  subtitle: string | null;
}

export const DEFAULT_PIPELINE_HEADING: PipelineHeading = {
  title: DEFAULT_PIPELINE_TITLE,
  subtitle: DEFAULT_PIPELINE_SUBTITLE,
};

/** Resolve stored columns (either of which may be null/blank) for rendering. */
export function resolvePipelineHeading(
  title: string | null | undefined,
  subtitle: string | null | undefined,
): PipelineHeading {
  return {
    title: title?.trim() ? title.trim() : DEFAULT_PIPELINE_TITLE,
    subtitle: subtitle?.trim() ? subtitle.trim() : DEFAULT_PIPELINE_SUBTITLE,
  };
}

/** Raised when a submitted heading field is the wrong type or too long. */
export class InvalidPipelineHeadingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPipelineHeadingError';
  }
}

/**
 * Coerce an untrusted `{ title, subtitle }` payload into the values to store.
 * Blank (or whitespace-only) input is stored as `null` rather than an empty
 * string, so a cleared field reads back as the default instead of rendering a
 * gap. Throws `InvalidPipelineHeadingError` on a non-string or over-long value.
 */
export function parsePipelineHeadingInput(value: unknown): PipelineHeadingInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidPipelineHeadingError('A { title, subtitle } object is required');
  }
  const raw = value as Record<string, unknown>;
  return {
    title: parseField(raw.title, 'title', PIPELINE_TITLE_MAX_LENGTH),
    subtitle: parseField(raw.subtitle, 'subtitle', PIPELINE_SUBTITLE_MAX_LENGTH),
  };
}

function parseField(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new InvalidPipelineHeadingError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new InvalidPipelineHeadingError(`${field} must be ${maxLength} characters or fewer`);
  }
  return trimmed;
}
