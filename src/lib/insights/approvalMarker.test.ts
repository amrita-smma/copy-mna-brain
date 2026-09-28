import { describe, expect, it } from 'vitest';
import {
  INSIGHT_CREATE_APPROVAL_MARKER,
  INSIGHT_EDIT_APPROVAL_MARKER,
  REPORT_PLAN_APPROVAL_MARKER,
  encodeApprovalMarker,
  extractApprovalPayload,
  resolveApprovalPayload,
  stripApprovalMarkers,
} from './approvalMarker';

/** The shape a real insight document has: comments, quotes, angle brackets. */
const HOSTILE_DOC = `<!DOCTYPE html>
<html><head><!-- chart section --><style>.a::after{content:"-->"}</style></head>
<body><script>if (1 --> 0) {}</script><p>A — B "quoted" <tag></p></body></html>`;

describe('encodeApprovalMarker / extractApprovalPayload', () => {
  it('round-trips a payload whose document contains HTML comments', () => {
    const payload = { approval_id: 'a1', name: 'Brief', description: '', html: HOSTILE_DOC };
    const text = `Proposal ready.\n${encodeApprovalMarker(INSIGHT_CREATE_APPROVAL_MARKER, payload)}`;

    const out = extractApprovalPayload<typeof payload>(text, INSIGHT_CREATE_APPROVAL_MARKER);
    expect(out).toEqual(payload);
    // The document must survive byte-for-byte — it is published verbatim.
    expect(out?.html).toBe(HOSTILE_DOC);
  });

  it('produces a marker that contains no "-->" of its own', () => {
    const encoded = encodeApprovalMarker(INSIGHT_CREATE_APPROVAL_MARKER, { html: HOSTILE_DOC });
    // One terminator, at the very end: the document inside cannot close it early.
    expect(encoded.split('-->').length - 1).toBe(1);
    expect(encoded.endsWith('-->')).toBe(true);
  });

  it.each([
    ['non-ASCII text', '<p>— 中文 · emoji 🎉 · café</p>'],
    ['a document large enough to be realistic', `<div>${'x'.repeat(200_000)}</div><!-- end -->`],
  ])('round-trips %s', (_, html) => {
    const text = encodeApprovalMarker(INSIGHT_EDIT_APPROVAL_MARKER, { html });
    expect(extractApprovalPayload<{ html: string }>(text, INSIGHT_EDIT_APPROVAL_MARKER)?.html).toBe(html);
  });

  it.each([
    ['a corrupt payload', `<!-- ${INSIGHT_CREATE_APPROVAL_MARKER}:not+valid+base64!!! -->`],
    ['an absent marker', 'just prose'],
  ])('returns null rather than throwing on %s', (_, text) => {
    expect(extractApprovalPayload(text, INSIGHT_CREATE_APPROVAL_MARKER)).toBeNull();
  });

  it('does not confuse the create, edit and report plan markers', () => {
    const text = encodeApprovalMarker(INSIGHT_EDIT_APPROVAL_MARKER, { html: 'x' });
    expect(extractApprovalPayload(text, INSIGHT_CREATE_APPROVAL_MARKER)).toBeNull();
    expect(extractApprovalPayload(text, INSIGHT_EDIT_APPROVAL_MARKER)).toEqual({ html: 'x' });

    const plan = { approval_id: 'rp-1', questions: [{ id: 'q1', options: [{ label: 'Yes', recommended: true }] }] };
    const planText = encodeApprovalMarker(REPORT_PLAN_APPROVAL_MARKER, plan);
    expect(extractApprovalPayload(planText, REPORT_PLAN_APPROVAL_MARKER)).toEqual(plan);
    expect(extractApprovalPayload(planText, INSIGHT_EDIT_APPROVAL_MARKER)).toBeNull();
  });
});

describe('stripApprovalMarkers', () => {
  it('leaves no trace of a payload whose document contains comments', () => {
    const text = `Here you go.\n${encodeApprovalMarker(INSIGHT_CREATE_APPROVAL_MARKER, { html: HOSTILE_DOC })}`;
    const stripped = stripApprovalMarkers(text);
    expect(stripped).toBe('Here you go.');
    expect(stripped).not.toContain(INSIGHT_CREATE_APPROVAL_MARKER);
    // The regression this guards: a truncated strip leaves document bytes
    // behind, and a multi-kilobyte document renders into the transcript.
    expect(stripped).not.toContain('DOCTYPE');
  });

  it('strips all marker kinds including report plan', () => {
    const text = [
      'a',
      encodeApprovalMarker(INSIGHT_CREATE_APPROVAL_MARKER, { html: '<!-- c -->' }),
      encodeApprovalMarker(INSIGHT_EDIT_APPROVAL_MARKER, { html: '<!-- e -->' }),
      encodeApprovalMarker(REPORT_PLAN_APPROVAL_MARKER, { methodology: '<!-- p -->' }),
    ].join('\n');
    expect(stripApprovalMarkers(text)).toBe('a');
  });

  it('leaves unrelated text untouched', () => {
    expect(stripApprovalMarkers('no markers <!-- ordinary comment -->')).toBe(
      'no markers <!-- ordinary comment -->',
    );
  });
});

describe('resolveApprovalPayload', () => {
  it('uses html from old marker when present and non-empty', () => {
    const oldMarker = { approval_id: 'a1', name: 'Doc', html: '  <p>old</p>  ' };
    const resolved = resolveApprovalPayload(oldMarker, { html: '<p>from-input</p>' });
    expect(resolved).toEqual({
      approval_id: 'a1',
      name: 'Doc',
      html: '  <p>old</p>  ',
    });
  });

  it('uses trimmed input html for new marker without html', () => {
    const newMarker = { approval_id: 'a2', name: 'Doc' };
    const resolved = resolveApprovalPayload(newMarker, { html: '  <p>new</p>  \n' });
    expect(resolved).toEqual({
      approval_id: 'a2',
      name: 'Doc',
      html: '<p>new</p>',
    });
  });

  it.each<[unknown]>([[{}], [undefined], [null], [{ html: 12345 }], [{ html: null }], [{ html: true }], [{ html: {} }]])(
    'returns null when neither marker nor input provides string html (%j)',
    (input) => {
      const marker = { approval_id: 'a3', name: 'Doc' };
      expect(resolveApprovalPayload(marker, input)).toBeNull();
    },
  );
});

