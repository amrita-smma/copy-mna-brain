import { describe, it, expect } from 'vitest';
import {
  TOOL_OUTPUT_CLIENT_CHARS,
  clipToolOutput,
  clipToolOutputText,
  clipToolParts,
  toolOutputClip,
  toolOutputContent,
} from './toolOutputClip';
import { encodeApprovalMarker, INSIGHT_EDIT_APPROVAL_MARKER } from '@/lib/insights/approvalMarker';

const long = 'x'.repeat(TOOL_OUTPUT_CLIENT_CHARS + 500);

describe('clipToolOutputText', () => {
  it('leaves an output that fits alone', () => {
    expect(clipToolOutputText('short')).toEqual({ content: 'short', fullChars: 5, clipped: false });
  });

  it('keeps the head and reports the visible length', () => {
    const cut = clipToolOutputText(long);
    expect(cut.clipped).toBe(true);
    expect(cut.content).toBe('x'.repeat(TOOL_OUTPUT_CLIENT_CHARS));
    expect(cut.fullChars).toBe(long.length);
  });

  it('keeps every hidden marker whole after the cut, whatever its payload', () => {
    const approval = encodeApprovalMarker(INSIGHT_EDIT_APPROVAL_MARKER, { insight_id: 'i1', summary: 's' });
    const citations = '<!-- CITATIONS_JSON:[{"url":"https://a.example","title":"A"}] -->';
    const navigate = '<!-- NAVIGATE_PAGE_JSON:{"page":"pipeline"} -->';
    const content = `${citations}\n${long}\n${approval}\n${navigate}`;

    const cut = clipToolOutputText(content);

    expect(cut.clipped).toBe(true);
    expect(cut.content).toContain(approval);
    expect(cut.content).toContain(citations);
    expect(cut.content).toContain(navigate);
    expect(cut.content.startsWith(`\n${'x'.repeat(TOOL_OUTPUT_CLIENT_CHARS - 1)}\n`)).toBe(true);
    // The markers do not count toward what the user sees.
    expect(cut.fullChars).toBe(long.length + 3);
  });

  it('does not count markers toward the cap, so a marker-heavy short output fits', () => {
    const payload = `<!-- COMPANY_MENTIONS_JSON:${JSON.stringify({ companies: 'y'.repeat(5000) })} -->`;
    const content = `Found 3 companies.\n${payload}`;
    expect(clipToolOutputText(content)).toEqual({ content, fullChars: 19, clipped: false });
  });

  it('leaves an ordinary HTML comment inside the document to the cut', () => {
    const content = `<!-- a lowercase comment -->${long}`;
    const cut = clipToolOutputText(content);
    expect(cut.content.startsWith('<!-- a lowercase comment -->')).toBe(true);
    expect(cut.content).toHaveLength(TOOL_OUTPUT_CLIENT_CHARS);
  });
});

describe('clipToolOutput', () => {
  it('returns a fitting output as is, whatever its shape', () => {
    const message = { lc: 1, kwargs: { content: 'fine', tool_call_id: 'toolu_1' } };
    expect(clipToolOutput(message)).toBe(message);
    expect(clipToolOutput('fine')).toBe('fine');
    expect(clipToolOutput({ kwargs: { content: ['block'] } })).toEqual({ kwargs: { content: ['block'] } });
    expect(clipToolOutput(undefined)).toBeUndefined();
  });

  it("clips a streamed ToolMessage to its head and names the call by the message's own id", () => {
    const out = clipToolOutput({ lc: 1, kwargs: { content: long, tool_call_id: 'toolu_1', name: 't' } });
    expect(out).toEqual({
      kwargs: { content: 'x'.repeat(TOOL_OUTPUT_CLIENT_CHARS) },
      clipped: { fullChars: long.length, toolCallId: 'toolu_1' },
    });
  });

  it('prefers the caller-supplied call id and omits one it cannot find', () => {
    expect(toolOutputClip(clipToolOutput(long, 'call-9'))).toEqual({ fullChars: long.length, toolCallId: 'call-9' });
    expect(toolOutputClip(clipToolOutput(long))).toEqual({ fullChars: long.length });
  });
});

describe('clipToolParts', () => {
  it('clips only tool parts with an output and keeps the others by reference', () => {
    const text = { type: 'text', text: long };
    const pending = { type: 'dynamic-tool', toolCallId: 'c1', toolName: 't', state: 'input-available', input: {} };
    const done = { ...pending, toolCallId: 'c2', state: 'output-available', output: { kwargs: { content: long } } };
    const small = { ...done, toolCallId: 'c3', output: { kwargs: { content: 'ok' } } };

    const [t, p, d, s] = clipToolParts([text, pending, done, small]);

    expect(t).toBe(text);
    expect(p).toBe(pending);
    expect(s).toBe(small);
    expect(d).toEqual({
      ...done,
      output: {
        kwargs: { content: 'x'.repeat(TOOL_OUTPUT_CLIENT_CHARS) },
        clipped: { fullChars: long.length, toolCallId: 'c2' },
      },
    });
  });
});

describe('toolOutputContent / toolOutputClip', () => {
  it('reads a string or a ToolMessage, and nothing else', () => {
    expect(toolOutputContent('s')).toBe('s');
    expect(toolOutputContent({ kwargs: { content: 'k' } })).toBe('k');
    expect(toolOutputContent({ kwargs: { content: 7 } })).toBeNull();
    expect(toolOutputContent(null)).toBeNull();
  });

  it('reads a clip note only when it is well formed', () => {
    expect(toolOutputClip({ kwargs: { content: '' }, clipped: { fullChars: 'no' } })).toBeNull();
    expect(toolOutputClip('s')).toBeNull();
    expect(toolOutputClip({ clipped: { fullChars: 3, toolCallId: 9 } })).toEqual({ fullChars: 3 });
  });
});
