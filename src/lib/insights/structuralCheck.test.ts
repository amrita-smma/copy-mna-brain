import { describe, it, expect } from 'vitest';
import {
  RENDER_CHECK_REFUSAL_LEAD,
  checkInsightStructure,
  checkInsightTruncation,
  insightStructureRefusal,
} from './structuralCheck';
import { makeTruncatedCandidate, makeTruncatedFragment } from './testFixtures';

describe('checkInsightStructure', () => {
  it.each([
    ['empty string', '', 'HTML document is empty.'],
    ['whitespace only', '   \n\t  ', 'HTML document is empty.'],
    ['<html><body><p>x (truncated, no closes)', '<html><body><p>x', 'Document contains an unclosed <html> tag (truncated HTML).'],
    ['<body><p>ok</p> with no </body>', '<body><p>ok</p>', 'Document contains an unclosed <body> tag (truncated HTML).'],
    ['unclosed <script>', '<html><body><script>const x = 1;</body></html>', 'Document contains an unclosed <script> tag (truncated HTML).'],
    ['unclosed <style>', '<html><body><style>body { color: red; }</body></html>', 'Document contains an unclosed <style> tag (truncated HTML).'],
    ['unterminated <!--', '<html><body><p>Hello</p><!-- unterminated comment</body></html>', 'Document contains an unterminated comment (truncated HTML).'],
    ['<html><body></body></html> (empty body)', '<html><body></body></html>', 'Document body is empty.'],
  ])('fails on %s', (_, html, expected) => {
    expect(checkInsightStructure(html)).toBe(expected);
  });

  it.each([
    ['a keyed fragment', '<section data-section="a"><p>hi</p></section>'],
    ['a full doc whose <script> body contains the string "<body>"', '<!DOCTYPE html><html><head><title>T</title></head><body><h1>H</h1><script>const str = "<body>";</script></body></html>'],
    ['a body containing only a chart div and script', '<html><body><div id="chart"></div><script>draw()</script></body></html>'],
    ['a fragment containing only a chart div and script', '<div id="chart"></div><script>draw()</script>'],
  ])('passes on %s', (_, html) => {
    expect(checkInsightStructure(html)).toBeNull();
  });

  it('fails on a placeholder with no tags with the documentGuard message', () => {
    expect(checkInsightStructure('This is just plain text with no tags at all.')).toContain(
      'The `html` argument contains no HTML',
    );
  });

  it('fails on kind: "report" violating the report contract', () => {
    expect(checkInsightStructure('<p>This is not a structured report.</p>', 'report')).not.toBeNull();
  });
});

describe('checkInsightTruncation', () => {
  it('returns the truncation reason without running the document guard', () => {
    expect(checkInsightTruncation('<html><body><p>x')).toMatch(/unclosed <html>/);
    // A placeholder has no truncation; only the full structural check refuses it.
    expect(checkInsightTruncation('see /tmp/report.html')).toBeNull();
    expect(checkInsightStructure('see /tmp/report.html')).not.toBeNull();
  });
});

describe('insightStructureRefusal', () => {
  it('passes a complete document for every audience', () => {
    const html = '<!DOCTYPE html><html><body><h1>Output</h1><p>62.1 Mt</p></body></html>';
    for (const audience of [
      'edit-proposal',
      'edit-section-proposal',
      'create-proposal',
      'workforce-document',
      'workforce-create',
      'workforce-section',
    ] as const) {
      expect(insightStructureRefusal(html, audience)).toBeNull();
    }
  });

  it('tells a chat agent that nothing was offered and the current version stays', () => {
    const out = insightStructureRefusal(makeTruncatedCandidate(), 'edit-proposal');
    expect(out).toMatch(new RegExp(`^${RENDER_CHECK_REFUSAL_LEAD}: Document contains an unclosed <html> tag`));
    expect(out).toContain('Nothing was offered to the user');
    expect(out).toContain("the insight's current version stays the current version");
  });

  it('tells a section proposal to resend the fragment and never the whole document', () => {
    const out = insightStructureRefusal(makeTruncatedFragment(), 'edit-section-proposal');
    expect(out).toMatch(/^Rejection: this candidate failed the render check \(in the section fragment\): Document contains an unclosed <script> tag/);
    expect(out).toContain('Nothing was offered to the user');
    expect(out).toContain('same `section`');
    expect(out).toContain('never the whole document');
  });

  it('tells a proposal for a new insight that nothing was created', () => {
    expect(insightStructureRefusal(makeTruncatedCandidate(), 'create-proposal')).toContain('no insight was created');
  });

  it('tells a workforce agent nothing was written, and names a fragment failure as such', () => {
    expect(insightStructureRefusal(makeTruncatedCandidate(), 'workforce-document')).toContain('Nothing was written');
    expect(insightStructureRefusal(makeTruncatedFragment(), 'workforce-section')).toMatch(
      /in the section fragment\): Document contains an unclosed <script> tag/,
    );
  });
});
