import { describe, expect, it } from 'vitest';
import { insightTemplatePart } from '@/lib/insights/templateAttachment';
import {
  formatInsightSelectionBlock,
  insightSelectionPart,
  type InsightSelectionAttachment,
} from '@/lib/insights/selectionAttachment';
import { readTurnRequest } from './turnRequest';

const user = (text: string, extra: unknown[] = []) => ({
  role: 'user',
  parts: [{ type: 'text', text }, ...extra],
});
const assistant = (text: string) => ({ role: 'assistant', parts: [{ type: 'text', text }] });

const TEMPLATE = { id: '11111111-2222-4333-8444-555555555555', name: 'Memo' };
const SELECTION: InsightSelectionAttachment = {
  insightId: '99999999-8888-4777-8666-555555555555',
  insightName: 'Q3 review',
  sections: [{ path: [0, 0], tags: ['div', 'h1'] }],
};

describe('readTurnRequest', () => {
  it('reads the latest user message, its text and the request options', () => {
    const request = readTurnRequest({
      show_intermediate_steps: true,
      bot_id: 'bot-1',
      effort: 'high',
      messages: [user('first'), assistant('reply'), user('second')],
      attachments: [{ key: 'chat-attachments/ws-1/a.pdf', fileName: 'a.pdf', contentType: 'application/pdf' }],
      page_context: { tabSlug: 'pipeline', path: '/pipeline' },
    });

    expect(request).toMatchObject({
      returnIntermediateSteps: true,
      requestedBotId: 'bot-1',
      requestedEffort: 'high',
      userText: 'second',
      turnText: 'second',
      previousUserText: 'first',
      hasAttachments: true,
      insightTemplate: null,
      insightSelection: null,
    });
    expect(request?.attachments).toHaveLength(1);
    expect(request?.pageContext?.tabSlug).toBe('pipeline');
    expect(request?.lastUserMessage).toEqual(user('second'));
  });

  it('is null when the body carries no user message', () => {
    expect(readTurnRequest({ messages: [assistant('hello')] })).toBeNull();
    expect(readTurnRequest({})).toBeNull();
    expect(readTurnRequest(null)).toBeNull();
  });

  it('defers to the server on an unrecognised effort and never pins the Auto-only deep tier', () => {
    expect(readTurnRequest({ messages: [user('q')], effort: 'auto' })?.requestedEffort).toBeNull();
    expect(readTurnRequest({ messages: [user('q')], effort: 'deep' })?.requestedEffort).toBeNull();
    expect(readTurnRequest({ messages: [user('q')], effort: 'low' })?.requestedEffort).toBe('low');
  });

  it('treats an empty bot_id as the default bot and anything but a string the same way', () => {
    expect(readTurnRequest({ messages: [user('q')], bot_id: '' })?.requestedBotId).toBeUndefined();
    expect(readTurnRequest({ messages: [user('q')], bot_id: 7 })?.requestedBotId).toBeUndefined();
  });

  it('keeps only the text parts on the message handed to the agent, and reads the attachment parts aside', () => {
    const request = readTurnRequest({
      messages: [user('fill this in', [insightTemplatePart(TEMPLATE), insightSelectionPart(SELECTION)])],
    });

    expect(request?.lastUserMessage.parts).toEqual([{ type: 'text', text: 'fill this in' }]);
    expect(request?.insightTemplate).toEqual(TEMPLATE);
    expect(request?.insightSelection).toEqual(SELECTION);
    // A template is a whole document to author: it counts as an attachment.
    expect(request?.hasAttachments).toBe(true);
  });

  it('puts the selection addresses on the turn text, not on the user text', () => {
    const request = readTurnRequest({
      messages: [user('make it shorter', [insightSelectionPart(SELECTION)])],
    });

    expect(request?.userText).toBe('make it shorter');
    expect(request?.turnText).toBe(
      `${formatInsightSelectionBlock(SELECTION, { includeContent: false })}\n\nmake it shorter`,
    );
  });

  it('reads the previous user turn the same way, selection included', () => {
    const request = readTurnRequest({
      messages: [user('edit the title', [insightSelectionPart(SELECTION)]), assistant('done'), user('and now?')],
    });

    expect(request?.previousUserText).toBe(
      `${formatInsightSelectionBlock(SELECTION, { includeContent: false })}\n\nedit the title`,
    );
  });

  it('accepts the legacy content shape, as one text part', () => {
    const request = readTurnRequest({
      messages: [
        { role: 'user', content: 'earlier' },
        { role: 'user', content: { nested: true } },
      ],
    });

    expect(request?.lastUserMessage.parts).toEqual([{ type: 'text', text: '{"nested":true}' }]);
    expect(request?.userText).toBe('{"nested":true}');
    expect(request?.previousUserText).toBe('earlier');
  });

  it('has no previous turn on the first message, and no attachments when none are sent', () => {
    const request = readTurnRequest({ messages: [user('hi')], attachments: 'nope' });

    expect(request?.previousUserText).toBeNull();
    expect(request?.attachments).toEqual([]);
    expect(request?.hasAttachments).toBe(false);
    expect(request?.pageContext).toBeNull();
    expect(request?.returnIntermediateSteps).toBe(false);
  });
});
