import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { CHAT_ATTACHMENTS_KWARG } from './largeDocumentTurn';
import {
  INSIGHT_SELECTION_KWARG,
  formatInsightSelectionBlock,
  type InsightSelectionAttachment,
} from '@/lib/insights/selectionAttachment';
import { TOO_LARGE_FOR_CHAT_STATUS } from '@/lib/insights/templateAttachment';
import { buildTurnMessage } from './turnMessage';
import type { TurnRequest } from './turnRequest';

const { toBaseMessagesMock } = vi.hoisted(() => ({ toBaseMessagesMock: vi.fn() }));
vi.mock('@ai-sdk/langchain', () => ({ toBaseMessages: toBaseMessagesMock }));

const REF = { key: 'chat-attachments/ws-1/deck.pdf', fileName: 'deck.pdf', contentType: 'application/pdf' };
const TEMPLATE = { id: '11111111-2222-4333-8444-555555555555', name: 'Memo' };
const SELECTION: InsightSelectionAttachment = {
  insightId: '99999999-8888-4777-8666-555555555555',
  insightName: 'Q3 review',
  sections: [{ path: [0, 0], tags: ['div', 'h1'] }],
};

const request = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  returnIntermediateSteps: false,
  requestedBotId: undefined,
  requestedEffort: null,
  attachments: [],
  pageContext: null,
  lastUserMessage: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
  insightTemplate: null,
  insightSelection: null,
  userText: 'hello',
  turnText: 'hello',
  previousUserText: null,
  hasAttachments: false,
  ...over,
});

describe('buildTurnMessage', () => {
  const prepareAttachments = vi.fn();
  const ownedRefs = vi.fn();
  const prepareTemplate = vi.fn();
  const deps = {
    chatAttachmentService: { prepareForMessage: prepareAttachments, ownedRefs },
    insightTemplateService: { prepareForMessage: prepareTemplate },
  } as never;

  beforeEach(() => {
    toBaseMessagesMock.mockReset().mockResolvedValue([new HumanMessage('hello')]);
    prepareAttachments.mockReset().mockResolvedValue({ blocks: [], fileIds: [], outlinedHtml: [] });
    ownedRefs.mockReset().mockImplementation((refs: unknown) => refs);
    prepareTemplate.mockReset();
  });

  it('converts a plain text turn with toBaseMessages and uploads nothing', async () => {
    const built = await buildTurnMessage(request(), deps);

    expect(toBaseMessagesMock).toHaveBeenCalledWith([request().lastUserMessage]);
    expect(built).toEqual({
      messages: [new HumanMessage('hello')],
      uploadedFileIds: [],
      carriesTooLargeDocument: false,
    });
    expect(prepareAttachments).not.toHaveBeenCalled();
  });

  it('builds the human message itself when files are attached: text first, file blocks after, refs recorded', async () => {
    const fileBlock = { type: 'document', source: { type: 'file', file_id: 'file_1' } };
    prepareAttachments.mockResolvedValue({ blocks: [fileBlock], fileIds: ['file_1'], outlinedHtml: [] });

    const built = await buildTurnMessage(
      request({ attachments: [REF], userText: 'summarize this', hasAttachments: true }),
      deps,
    );

    expect(prepareAttachments).toHaveBeenCalledWith([REF], { largeHtml: 'outline' });
    expect(toBaseMessagesMock).not.toHaveBeenCalled();
    const [human] = built.messages;
    expect(human).toBeInstanceOf(HumanMessage);
    expect(human.content).toEqual([{ type: 'text', text: 'summarize this' }, fileBlock]);
    expect(human.additional_kwargs).toEqual({ [CHAT_ATTACHMENTS_KWARG]: [REF] });
    expect(built.uploadedFileIds).toEqual(['file_1']);
    expect(built.carriesTooLargeDocument).toBe(false);
  });

  it('gives an attachment-only turn a fallback text so the model is told what to do', async () => {
    const built = await buildTurnMessage(request({ attachments: [REF], userText: '' }), deps);

    expect(built.messages[0].content).toEqual([{ type: 'text', text: 'Please review the attached file(s).' }]);
  });

  it('runs the template read and the uploads together, and places the template before the words', async () => {
    let templateResolved = false;
    prepareTemplate.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            templateResolved = true;
            resolve({ type: 'text', text: '<insight_template>…</insight_template>' });
          }, 5),
        ),
    );
    prepareAttachments.mockImplementation(async () => {
      expect(templateResolved).toBe(false);
      return { blocks: [], fileIds: [], outlinedHtml: [] };
    });

    const built = await buildTurnMessage(
      request({ insightTemplate: TEMPLATE, userText: '', hasAttachments: true }),
      deps,
    );

    expect(prepareTemplate).toHaveBeenCalledWith(TEMPLATE);
    expect(built.messages[0].content).toEqual([
      { type: 'text', text: '<insight_template>…</insight_template>' },
      { type: 'text', text: 'Create an insight from the attached template.' },
    ]);
    expect(built.messages[0].additional_kwargs).toEqual({});
  });

  it('flags a document too large for chat: an outlined HTML file or a too-large template', async () => {
    prepareAttachments.mockResolvedValue({ blocks: [], fileIds: [], outlinedHtml: ['deck.html'] });
    const outlined = await buildTurnMessage(request({ attachments: [REF] }), deps);
    expect(outlined.carriesTooLargeDocument).toBe(true);

    prepareAttachments.mockResolvedValue({ blocks: [], fileIds: [], outlinedHtml: [] });
    prepareTemplate.mockResolvedValue({
      type: 'text',
      text: `<insight_template id="${TEMPLATE.id}" name="Memo" status="${TOO_LARGE_FOR_CHAT_STATUS}">outline</insight_template>`,
    });
    const template = await buildTurnMessage(request({ insightTemplate: TEMPLATE }), deps);
    expect(template.carriesTooLargeDocument).toBe(true);
  });

  it('puts a selection in its own block before the words and records it for the chip', async () => {
    const built = await buildTurnMessage(
      request({ insightSelection: SELECTION, userText: 'shorten it' }),
      deps,
    );

    expect(built.messages[0].content).toEqual([
      { type: 'text', text: formatInsightSelectionBlock(SELECTION) },
      { type: 'text', text: 'shorten it' },
    ]);
    expect(built.messages[0].additional_kwargs).toEqual({ [INSIGHT_SELECTION_KWARG]: SELECTION });
  });

  it('lets an attachment the user may not read fail the build', async () => {
    const forbidden = new Error('forbidden');
    prepareAttachments.mockRejectedValue(forbidden);

    await expect(buildTurnMessage(request({ attachments: [REF] }), deps)).rejects.toBe(forbidden);
  });
});
