import { describe, expect, it } from 'vitest';
import {
  insightCreateSchema,
  validateInsightCreate,
  validateInsightDocument,
} from './toolValidation';
import { RENDER_CHECK_REFUSAL_LEAD } from './structuralCheck';
import { makeTruncatedCandidate, makeValidReport } from './testFixtures';

describe('validateInsightDocument', () => {
  it('returns the trimmed document when it passes', () => {
    expect(validateInsightDocument('  <p>62.1 Mt</p>  ', 'document', 'edit-proposal')).toEqual({
      html: '<p>62.1 Mt</p>',
    });
  });

  it('refuses an empty document before any other check', () => {
    expect(validateInsightDocument('   ', undefined, 'edit-proposal')).toEqual({
      error: 'Rejection: No HTML document provided.',
    });
  });

  it('runs the render check first when given an audience, ahead of the report contract', () => {
    const truncatedReport = `<html><body>${makeValidReport().slice(0, 400)}`;

    const result = validateInsightDocument(truncatedReport, 'report', 'edit-proposal');

    expect('error' in result && result.error.startsWith(RENDER_CHECK_REFUSAL_LEAD)).toBe(true);
  });

  it('skips the render check without an audience, leaving the existing guard in charge', () => {
    const result = validateInsightDocument(makeTruncatedCandidate());
    expect(result).toEqual({ html: makeTruncatedCandidate().trim() });
  });
});

describe('validateInsightCreate', () => {
  it('passes the audience through to the render check', () => {
    const result = validateInsightCreate('Output', makeTruncatedCandidate(), 'document', 'create-proposal');
    expect('error' in result && result.error).toContain('no insight was created');
  });

  it('still checks the name first', () => {
    expect(validateInsightCreate(' ', makeTruncatedCandidate(), 'document', 'create-proposal')).toEqual({
      error: 'Rejection: An insight name is required.',
    });
  });
});

describe('insightCreateSchema', () => {
  const base = { name: 'Sector Brief', html: '<p>doc</p>' };
  const TEMPLATE_ID = '66666666-7777-4888-9999-000000000000';

  it('accepts an optional uuid template_id', () => {
    expect(insightCreateSchema.parse({ ...base, template_id: TEMPLATE_ID }).template_id).toBe(TEMPLATE_ID);
  });

  it('leaves template_id undefined when it is omitted', () => {
    expect(insightCreateSchema.parse(base).template_id).toBeUndefined();
  });

  it('accepts a template_id that is not a uuid, so the call is not refused over it', () => {
    expect(insightCreateSchema.safeParse({ ...base, template_id: 'market-brief' }).success).toBe(true);
  });
});
