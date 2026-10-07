import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PIPELINE_HEADING,
  DEFAULT_PIPELINE_SUBTITLE,
  DEFAULT_PIPELINE_TITLE,
  InvalidPipelineHeadingError,
  PIPELINE_SUBTITLE_MAX_LENGTH,
  PIPELINE_TITLE_MAX_LENGTH,
  parsePipelineHeadingInput,
  resolvePipelineHeading,
} from './heading';

describe('resolvePipelineHeading', () => {
  it('returns the stored values when both are set', () => {
    expect(resolvePipelineHeading('Acquisitions', 'Our live targets')).toEqual({
      title: 'Acquisitions',
      subtitle: 'Our live targets',
    });
  });

  it('falls back to the product defaults when both are null', () => {
    expect(resolvePipelineHeading(null, null)).toEqual(DEFAULT_PIPELINE_HEADING);
  });

  it('falls back per field, so one customised value does not blank the other', () => {
    expect(resolvePipelineHeading('Acquisitions', null)).toEqual({
      title: 'Acquisitions',
      subtitle: DEFAULT_PIPELINE_SUBTITLE,
    });
    expect(resolvePipelineHeading(null, 'Our live targets')).toEqual({
      title: DEFAULT_PIPELINE_TITLE,
      subtitle: 'Our live targets',
    });
  });

  it('treats a whitespace-only stored value as unset', () => {
    expect(resolvePipelineHeading('   ', '\t\n')).toEqual(DEFAULT_PIPELINE_HEADING);
  });

  it('trims surrounding whitespace off stored values', () => {
    expect(resolvePipelineHeading('  Acquisitions  ', '  Targets  ')).toEqual({
      title: 'Acquisitions',
      subtitle: 'Targets',
    });
  });

  it('handles undefined, which is what a missing workspace row yields', () => {
    expect(resolvePipelineHeading(undefined, undefined)).toEqual(DEFAULT_PIPELINE_HEADING);
  });
});

describe('parsePipelineHeadingInput', () => {
  it('trims both fields', () => {
    expect(parsePipelineHeadingInput({ title: '  Acquisitions ', subtitle: ' Targets ' })).toEqual({
      title: 'Acquisitions',
      subtitle: 'Targets',
    });
  });

  it('stores a blank field as null so it reads back as the default', () => {
    expect(parsePipelineHeadingInput({ title: '', subtitle: '   ' })).toEqual({
      title: null,
      subtitle: null,
    });
  });

  it('treats a missing field as null rather than rejecting the payload', () => {
    expect(parsePipelineHeadingInput({ title: 'Acquisitions' })).toEqual({
      title: 'Acquisitions',
      subtitle: null,
    });
  });

  it('rejects a non-object payload', () => {
    expect(() => parsePipelineHeadingInput('Acquisitions')).toThrow(InvalidPipelineHeadingError);
    expect(() => parsePipelineHeadingInput(null)).toThrow(InvalidPipelineHeadingError);
    expect(() => parsePipelineHeadingInput([])).toThrow(InvalidPipelineHeadingError);
  });

  it('rejects a non-string field', () => {
    expect(() => parsePipelineHeadingInput({ title: 42 })).toThrow(InvalidPipelineHeadingError);
    expect(() => parsePipelineHeadingInput({ subtitle: { a: 1 } })).toThrow(
      InvalidPipelineHeadingError,
    );
  });

  it('rejects an over-long title or subtitle', () => {
    expect(() =>
      parsePipelineHeadingInput({ title: 'x'.repeat(PIPELINE_TITLE_MAX_LENGTH + 1) }),
    ).toThrow(/title must be 80 characters or fewer/);
    expect(() =>
      parsePipelineHeadingInput({ subtitle: 'x'.repeat(PIPELINE_SUBTITLE_MAX_LENGTH + 1) }),
    ).toThrow(/subtitle must be 160 characters or fewer/);
  });

  it('accepts a field exactly at the limit', () => {
    const title = 'x'.repeat(PIPELINE_TITLE_MAX_LENGTH);
    expect(parsePipelineHeadingInput({ title })).toEqual({ title, subtitle: null });
  });

  it('measures length after trimming, so padding alone cannot fail validation', () => {
    const title = `  ${'x'.repeat(PIPELINE_TITLE_MAX_LENGTH)}  `;
    expect(parsePipelineHeadingInput({ title }).title).toHaveLength(PIPELINE_TITLE_MAX_LENGTH);
  });
});
