import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  CHAT_ATTACHMENTS_KWARG,
  latestUserAttachments,
  previousTurnTimedOut,
  TIMED_OUT_FOLLOW_UP_CONTEXT,
  timeoutFollowUpContext,
  WHOLE_DOCUMENT_TOOL_NAMES,
  wholeDocumentToolsToWithhold,
  ZERO_WORK_FOLLOW_UP_CONTEXT,
} from './largeDocumentTurn';
import { buildBudgetNotice, TIMEOUT_WORKFORCE_OFFER } from './turnBudget';

const zeroWork = buildBudgetNotice({ budgetMs: 180_000 });
const withTools = buildBudgetNotice({ budgetMs: 180_000, toolNames: ['web_search'] });

const ref = (name: string) => ({
  key: `chat-attachments/ws-1/${name}`,
  fileName: name,
  contentType: 'text/html',
});
const withAttachments = (text: string, refs: unknown) =>
  new HumanMessage({ content: text, additional_kwargs: { [CHAT_ATTACHMENTS_KWARG]: refs } });
/** Stand-in for ChatAttachmentService.ownedRefs: keeps well-formed refs under ws-1. */
const validate = (raw: unknown) =>
  (raw as Array<{ key?: unknown }>).filter(
    (r): r is ReturnType<typeof ref> =>
      Boolean(r) && typeof r.key === 'string' && r.key.startsWith('chat-attachments/ws-1/'),
  );

describe('previousTurnTimedOut', () => {
  it("is 'no-work' when the previous turn ended on the zero-work notice", () => {
    expect(previousTurnTimedOut([new HumanMessage('build the insight'), new AIMessage(zeroWork)])).toBe('no-work');
  });

  it("is 'with-work' when the previous turn timed out after tools completed", () => {
    expect(
      previousTurnTimedOut([
        new HumanMessage('rank them'),
        new ToolMessage({ content: 'r', name: 'web_search', tool_call_id: 't1' }),
        new AIMessage(withTools),
      ]),
    ).toBe('with-work');
  });

  it("is 'with-work' for a model-written wrap-up that closes on the Workforce offer", () => {
    expect(
      previousTurnTimedOut([
        new HumanMessage('remove this sidebar'),
        new AIMessage(`I ran out of time. I read the insight.\n\n${TIMEOUT_WORKFORCE_OFFER}`),
      ]),
    ).toBe('with-work');
  });

  it('is null after an ordinary answer, or on a fresh thread', () => {
    expect(previousTurnTimedOut([new HumanMessage('q'), new AIMessage('an answer')])).toBeNull();
    expect(previousTurnTimedOut([])).toBeNull();
  });

  it('reads the last assistant message of the previous turn only', () => {
    // The notice was already followed up; the latest turn answered normally.
    expect(
      previousTurnTimedOut([
        new HumanMessage('build it'),
        new AIMessage(zeroWork),
        new HumanMessage('continue'),
        new AIMessage('Handed to the Workforce.'),
      ]),
    ).toBeNull();
    // An older notice does not count when the previous turn left no assistant message.
    expect(
      previousTurnTimedOut([new HumanMessage('build it'), new AIMessage(zeroWork), new HumanMessage('continue')]),
    ).toBeNull();
  });

  it('reads content-block messages as text', () => {
    expect(
      previousTurnTimedOut([
        new HumanMessage('build it'),
        new AIMessage({ content: [{ type: 'text', text: zeroWork }] }),
      ]),
    ).toBe('no-work');
  });
});

describe('timeoutFollowUpContext', () => {
  it('tells the model to hand off now after a zero-work timeout, carrying the template_id', () => {
    const context = timeoutFollowUpContext('no-work');
    expect(context).toBe(ZERO_WORK_FOLLOW_UP_CONTEXT);
    expect(context).toContain('Call propose_workforce_handoff now');
    expect(context).toContain('template_id');
    expect(context).toContain('Do not try to write the document in this turn');
  });

  it('after a timeout with work, hands a document request off with the edit target but lets research continue', () => {
    const context = timeoutFollowUpContext('with-work');
    expect(context).toBe(TIMED_OUT_FOLLOW_UP_CONTEXT);
    expect(context).toContain('create or edit an insight');
    expect(context).toContain('propose_workforce_handoff');
    expect(context).toContain('insight_id');
    expect(context).toContain('element path');
    expect(context).toContain('Otherwise continue');
  });

  it('adds nothing when the previous turn did not time out', () => {
    expect(timeoutFollowUpContext(null)).toBeNull();
  });
});

describe('latestUserAttachments', () => {
  it('returns the refs of the most recent user turn that carried any', () => {
    const messages = [
      withAttachments('first', [ref('old.html')]),
      new AIMessage('ok'),
      withAttachments('second', [ref('brief.html')]),
      new AIMessage('ok'),
      new HumanMessage('now hand it off'),
    ];

    expect(latestUserAttachments(messages, validate)).toEqual([ref('brief.html')]);
  });

  it('skips a turn whose refs all fail validation', () => {
    const messages = [
      withAttachments('first', [ref('brief.html')]),
      withAttachments('spoofed', [{ key: 'chat-attachments/other-ws/x.html', fileName: 'x', contentType: 'text/html' }]),
    ];

    expect(latestUserAttachments(messages, validate)).toEqual([ref('brief.html')]);
  });

  it('returns [] when no user turn carried attachments', () => {
    expect(latestUserAttachments([new HumanMessage('q'), new AIMessage('a')], validate)).toEqual([]);
    expect(latestUserAttachments([withAttachments('q', 'not-an-array')], validate)).toEqual([]);
    expect(latestUserAttachments([], validate)).toEqual([]);
  });

  it('ignores refs on non-user messages', () => {
    const ai = new AIMessage({ content: 'a', additional_kwargs: { [CHAT_ATTACHMENTS_KWARG]: [ref('x.html')] } });

    expect(latestUserAttachments([ai], validate)).toEqual([]);
  });
});

describe('wholeDocumentToolsToWithhold', () => {
  it('withholds every whole-document tool on a turn that must hand off', () => {
    const all = [...WHOLE_DOCUMENT_TOOL_NAMES];
    expect(wholeDocumentToolsToWithhold({ previousTurnTimedOut: true, carriesTooLargeDocument: false })).toEqual(all);
    expect(wholeDocumentToolsToWithhold({ previousTurnTimedOut: false, carriesTooLargeDocument: true })).toEqual(all);
    expect(all).toEqual(['propose_insight_edit', 'replace_insight_document']);
  });

  it('withholds nothing on an ordinary turn', () => {
    expect(wholeDocumentToolsToWithhold({ previousTurnTimedOut: false, carriesTooLargeDocument: false })).toEqual([]);
  });
});
