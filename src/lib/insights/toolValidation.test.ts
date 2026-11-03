import { describe, expect, it } from 'vitest';
import {
  insightCreateSchema,
  validateInsightCreate,
  validateInsightDocument,
  validateInsightSectionEdit,
  validateSectionKey,
} from './toolValidation';
import { RENDER_CHECK_REFUSAL_LEAD } from './structuralCheck';
import { makeTruncatedCandidate, makeTruncatedFragment, makeValidReport } from './testFixtures';

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

describe('validateSectionKey', () => {
  it('returns the trimmed key when it is a data-section key', () => {
    expect(validateSectionKey('  risk-summary ')).toEqual({ key: 'risk-summary' });
    expect(validateSectionKey('Block_2')).toEqual({ key: 'Block_2' });
  });

  it('refuses an empty key and one with characters a key cannot carry', () => {
    expect(validateSectionKey('   ')).toEqual({ error: 'Rejection: A section key is required.' });
    const bad = validateSectionKey('risk summary');
    expect('error' in bad && bad.error).toContain('is not a data-section key');
    const quoted = validateSectionKey('"risks"');
    expect('error' in quoted && quoted.error).toContain('is not a data-section key');
  });
});

describe('validateInsightSectionEdit', () => {
  const current =
    '<!DOCTYPE html><html><body><h1>Brief</h1>' +
    '<section data-section="summary"><h2>Summary</h2><p>Up 4%.</p></section>' +
    '<section data-section="risks"><ul><li>FX</li></ul></section>' +
    '</body></html>';

  it('returns the trimmed fragment and the spliced document when everything passes', () => {
    const result = validateInsightSectionEdit(current, 'risks', '  <section data-section="risks"><ul><li>Rates</li></ul></section>\n', 'document');

    expect(result).toEqual({
      fragment: '<section data-section="risks"><ul><li>Rates</li></ul></section>',
      html: current.replace('<li>FX</li>', '<li>Rates</li>'),
    });
  });

  it('refuses an empty fragment', () => {
    expect(validateInsightSectionEdit(current, 'risks', '  ')).toEqual({
      error: 'Rejection: No HTML fragment provided for the section.',
    });
  });

  it('runs the render check on the fragment first, with the section wording', () => {
    const result = validateInsightSectionEdit(current, 'risks', makeTruncatedFragment());
    expect('error' in result && result.error).toMatch(/^Rejection: this candidate failed the render check \(in the section fragment\)/);
  });

  it('names the keys the document has when the section is missing', () => {
    const result = validateInsightSectionEdit(current, 'outlook', '<section data-section="outlook"></section>');
    expect('error' in result && result.error).toBe(
      'Rejection: Section "outlook" not found in document. The document\'s data-section keys are: "summary", "risks".',
    );
  });

  it('says a document with no keys cannot be edited by section', () => {
    const result = validateInsightSectionEdit('<p>no keys</p>', 'summary', '<section data-section="summary"></section>');
    expect('error' in result && result.error).toContain('has no data-section keys');
  });

  it('refuses a fragment that drops the key, naming the fix', () => {
    const result = validateInsightSectionEdit(current, 'risks', '<section><ul><li>Rates</li></ul></section>');
    expect('error' in result && result.error).toContain('must keep data-section="risks" on exactly one element');
  });

  it('refuses a fragment that carries the key twice', () => {
    const result = validateInsightSectionEdit(
      current,
      'risks',
      '<section data-section="risks"><div data-section="risks"></div></section>',
    );
    expect('error' in result && result.error).toContain('Duplicate section key "risks"');
  });

  it('checks the spliced document against the report contract', () => {
    const report = makeValidReport().trim();
    const result = validateInsightSectionEdit(report, 'summary', '<section data-section="summary"><p>Too short a summary.</p></section>', 'report');
    expect('error' in result && result.error).toMatch(/^Rejection: /);
    expect('error' in result && result.error).toContain('spliced into the current document for this check');
  });
});
