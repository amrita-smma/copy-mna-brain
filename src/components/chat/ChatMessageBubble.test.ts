import { describe, it, expect } from 'vitest';
import type { UIMessage } from '@ai-sdk/react';

import { parseAssistantTurn } from './ChatMessageBubble';
import { encodeApprovalMarker } from '@/lib/insights/approvalMarker';
import { OPTION_CARD_MARKER, buildOptionCard } from '@/lib/chat/optionCards';

/** A text part as the AI SDK streams it. */
const text = (value: string, state: 'streaming' | 'done' = 'done') =>
  ({ type: 'text', text: value, state }) as unknown as UIMessage['parts'][number];

/** A finished tool call with `content` at the shape the chat route produces. */
const tool = (toolName: string, content: string, input?: unknown) =>
  ({
    type: 'dynamic-tool',
    toolName,
    toolCallId: `${toolName}-1`,
    state: 'output-available',
    input,
    output: { kwargs: { content } },
  }) as unknown as UIMessage['parts'][number];

const parts = (...p: UIMessage['parts'][number][]): UIMessage['parts'] => p;

describe('parseAssistantTurn', () => {
  it('returns the plain answer untouched when the turn has no markers', () => {
    const result = parseAssistantTurn(parts(text('Acme looks like a fit.')));

    expect(result.responseText).toBe('Acme looks like a fit.');
    expect(result.thinkingText).toBe('');
    expect(result.warnings).toEqual([]);
    expect(result.toolParts).toEqual([]);
    expect(result.hasTextContent).toBe(true);
    expect(result.isStreamingComplete).toBe(true);
  });

  it('prefers genuine reasoning parts over the legacy thinking delimiters', () => {
    const result = parseAssistantTurn(
      parts(
        { type: 'reasoning', text: 'Checking the pipeline first.', state: 'done' } as never,
        text('Three deals are stalled.'),
      ),
    );

    expect(result.thinkingText).toBe('Checking the pipeline first.');
    expect(result.responseText).toBe('Three deals are stalled.');
    expect(result.hasReasoningContent).toBe(true);
  });

  it('splits legacy THINKING delimiters out of historical messages', () => {
    const result = parseAssistantTurn(
      parts(text('<!-- THINKING_START -->weighing it<!-- THINKING_END -->Here is the answer.')),
    );

    expect(result.thinkingText).toBe('weighing it');
    expect(result.responseText).toBe('Here is the answer.');
  });

  it('treats a part loaded from stored history (no state) as finished, so the Pinged footer survives a reload', () => {
    const stored = { type: 'text', text: 'I asked @Deal Scout to look.' } as unknown as UIMessage['parts'][number];
    const result = parseAssistantTurn(parts(stored));

    expect(result.isStreamingComplete).toBe(true);
    expect(result.responseText).toBe('I asked @Deal Scout to look.');

    const streaming = parseAssistantTurn(parts(text('I asked @Deal Scout', 'streaming')));
    expect(streaming.isStreamingComplete).toBe(false);
  });

  it('treats an unclosed THINKING block as still-streaming thought', () => {
    const result = parseAssistantTurn(
      parts(text('<!-- THINKING_START -->still working', 'streaming')),
    );

    expect(result.thinkingText).toBe('still working');
    expect(result.responseText).toBe('');
    expect(result.isStreamingComplete).toBe(false);
  });

  it('lifts WARNING blocks into banners and strips them from the prose', () => {
    const result = parseAssistantTurn(
      parts(text('Before: <!-- WARNING_START -->EBITDA is negative<!-- WARNING_END --> after.')),
    );

    expect(result.warnings).toEqual(['EBITDA is negative']);
    expect(result.responseText).toBe('Before:  after.');
  });

  it('drops an orphan WARNING_END without eating the surrounding text', () => {
    const result = parseAssistantTurn(parts(text('all good<!-- WARNING_END --> here')));

    expect(result.warnings).toEqual([]);
    expect(result.responseText).toBe('all good here');
  });

  it('collects de-duplicated citations from search tools', () => {
    const cites = JSON.stringify([
      { title: 'A', url: 'https://a.example' },
      { title: 'B', url: 'https://b.example' },
    ]);
    const result = parseAssistantTurn(
      parts(
        tool('web_search', `results <!-- CITATIONS_JSON:${cites} -->`),
        tool('valyu_search', `more <!-- CITATIONS_JSON:${cites} -->`),
        text('Here is what I found.'),
      ),
    );

    expect(result.allCitations).toEqual([
      { title: 'A', url: 'https://a.example' },
      { title: 'B', url: 'https://b.example' },
    ]);
  });

  it('ignores a malformed citations payload instead of throwing', () => {
    const result = parseAssistantTurn(
      parts(tool('web_search', 'oops <!-- CITATIONS_JSON:{not json} -->')),
    );

    expect(result.allCitations).toEqual([]);
  });

  it('collects de-duplicated files from query_files', () => {
    const files = JSON.stringify([{ id: 'n1', file_name: 'notes.pdf' }]);
    const result = parseAssistantTurn(
      parts(
        tool('query_files', `<!-- FILES_JSON:${files} -->`),
        tool('query_files', `<!-- FILES_JSON:${files} -->`),
      ),
    );

    expect(result.allMeetingNotes).toHaveLength(1);
    expect(result.allMeetingNotes[0].file_name).toBe('notes.pdf');
  });

  it('reads a workforce handoff payload out of its tool output', () => {
    const payload = JSON.stringify({ title: 'Diligence Acme', instruction: 'Run the L1 pack' });
    const result = parseAssistantTurn(
      parts(
        tool('propose_workforce_handoff', `<!-- WORKFORCE_HANDOFF_JSON:${payload} -->`),
      ),
    );

    expect(result.workforceHandoff).toEqual({
      title: 'Diligence Acme',
      instruction: 'Run the L1 pack',
    });
  });

  it('rejects a workforce handoff that is missing its instruction', () => {
    const payload = JSON.stringify({ title: 'Diligence Acme' });
    const result = parseAssistantTurn(
      parts(tool('propose_workforce_handoff', `<!-- WORKFORCE_HANDOFF_JSON:${payload} -->`)),
    );

    expect(result.workforceHandoff).toBeNull();
  });

  it('reads a bulk drop proposal and ignores one with no candidates', () => {
    const good = JSON.stringify({ title: 'Drop 2', candidates: [{ id: 'c1' }] });
    const empty = JSON.stringify({ title: 'Drop 0', candidates: [] });

    expect(
      parseAssistantTurn(
        parts(tool('propose_bulk_drop_companies', `<!-- BULK_DROP_APPROVAL_JSON:${good} -->`)),
      ).bulkDropApproval,
    ).toMatchObject({ title: 'Drop 2' });

    expect(
      parseAssistantTurn(
        parts(tool('propose_bulk_drop_companies', `<!-- BULK_DROP_APPROVAL_JSON:${empty} -->`)),
      ).bulkDropApproval,
    ).toBeNull();
  });

  it('requires a target stage on a bulk promote proposal', () => {
    const noStage = JSON.stringify({ title: 'Promote', candidates: [{ id: 'c1' }] });
    const withStage = JSON.stringify({
      title: 'Promote',
      target_stage: 'L1',
      candidates: [{ id: 'c1' }],
    });

    expect(
      parseAssistantTurn(
        parts(tool('propose_bulk_promote_companies', `<!-- BULK_PROMOTE_APPROVAL_JSON:${noStage} -->`)),
      ).bulkPromoteApproval,
    ).toBeNull();

    expect(
      parseAssistantTurn(
        parts(tool('propose_bulk_promote_companies', `<!-- BULK_PROMOTE_APPROVAL_JSON:${withStage} -->`)),
      ).bulkPromoteApproval,
    ).toMatchObject({ target_stage: 'L1' });
  });

  it('flags running tools and a running pptx send_email', () => {
    const running = {
      type: 'dynamic-tool',
      toolName: 'send_email',
      toolCallId: 'se-1',
      state: 'input-available',
      input: { presentation: { title: 'Acme deck' } },
    } as unknown as UIMessage['parts'][number];

    const result = parseAssistantTurn(parts(running));

    expect(result.hasRunningTools).toBe(true);
    expect(result.isPptxRunning).toBe(true);
  });

  it('reports no running tools once every call has an output', () => {
    const result = parseAssistantTurn(parts(tool('query_companies', 'rows')));

    expect(result.hasRunningTools).toBe(false);
    expect(result.isPptxRunning).toBe(false);
  });

  it('is a pure function of parts, so the bubble can memoize on it', () => {
    const input = parts(
      tool('web_search', 'x <!-- CITATIONS_JSON:[{"title":"A","url":"https://a.example"}] -->'),
      text('Answer.'),
    );

    expect(parseAssistantTurn(input)).toEqual(parseAssistantTurn(input));
  });

  it('reads each option card the bot offered, and ignores a malformed one', () => {
    const card = buildOptionCard({
      card_id: 'c1',
      question: 'Which markets?',
      mode: 'multi',
      options: [{ label: 'Indonesia' }, { label: 'Vietnam' }],
    });
    const result = parseAssistantTurn(
      parts(
        tool('offer_options', `Showed the user a card.\n\n${encodeApprovalMarker(OPTION_CARD_MARKER, card)}`),
        tool('offer_options', encodeApprovalMarker(OPTION_CARD_MARKER, { card_id: 'c2', question: 'q' })),
        text('Pick the markets above.'),
      ),
    );
    expect(result.optionCards).toEqual([card]);
  });

  it('handles an empty turn without throwing', () => {
    const result = parseAssistantTurn([]);

    expect(result.responseText).toBe('');
    expect(result.hasTextContent).toBe(false);
    expect(result.isStreamingComplete).toBe(false);
  });
});
