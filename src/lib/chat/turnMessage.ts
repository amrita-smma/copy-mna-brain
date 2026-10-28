/**
 * The human message a chat turn hands the agent.
 *
 * When the turn carries attachments, an insight template or an insight
 * selection, the message is built here rather than by `toBaseMessages`,
 * which only preserves text: files become Files-API `file` / image /
 * extracted-text blocks, the template becomes an `<insight_template>` text
 * block placed before the user's words, and the selection its own block.
 *
 * A template or HTML file too large for chat arrives as an outline plus a
 * hard instruction to hand it to the Workforce (`largeHtml: 'outline'`);
 * `carriesTooLargeDocument` is what makes the route withhold the
 * whole-document tools. The turn's attachment refs are recorded on the
 * message's `additional_kwargs` (never sent to the model), so a handoff on a
 * later turn can still carry the file.
 *
 * A `ChatAttachmentForbiddenError` from the attachment service passes
 * through: the route turns it into a 403.
 */
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { toBaseMessages } from '@ai-sdk/langchain';
import type { ChatAttachmentService } from '@/lib/services/chatAttachmentService';
import type { InsightTemplateService } from '@/lib/services/insightTemplateService';
import { isTooLargeInsightTemplateBlock } from '@/lib/insights/templateAttachment';
import {
  formatInsightSelectionBlock,
  INSIGHT_SELECTION_KWARG,
} from '@/lib/insights/selectionAttachment';
import { CHAT_ATTACHMENTS_KWARG } from './largeDocumentTurn';
import type { TurnRequest } from './turnRequest';

export interface TurnMessage {
  messages: BaseMessage[];
  /** This turn's Anthropic uploads: deleted once the turn has finished. */
  uploadedFileIds: string[];
  /** A template or HTML file too large for chat arrived as an outline. */
  carriesTooLargeDocument: boolean;
}

export interface TurnMessageDeps {
  chatAttachmentService: Pick<ChatAttachmentService, 'prepareForMessage' | 'ownedRefs'>;
  insightTemplateService: Pick<InsightTemplateService, 'prepareForMessage'>;
}

export async function buildTurnMessage(
  request: TurnRequest,
  { chatAttachmentService, insightTemplateService }: TurnMessageDeps,
): Promise<TurnMessage> {
  const { attachments, insightTemplate, insightSelection, userText } = request;
  if (attachments.length === 0 && !insightTemplate && !insightSelection) {
    return {
      messages: await toBaseMessages([request.lastUserMessage]),
      uploadedFileIds: [],
      carriesTooLargeDocument: false,
    };
  }

  // The template read and the file uploads are independent network work;
  // together, not one after the other.
  const [templateBlocks, prepared] = await Promise.all([
    insightTemplate
      ? insightTemplateService.prepareForMessage(insightTemplate).then((block) => [block])
      : Promise.resolve([]),
    chatAttachmentService.prepareForMessage(attachments, { largeHtml: 'outline' }),
  ]);
  const { blocks, fileIds, outlinedHtml } = prepared;
  const carriesTooLargeDocument =
    outlinedHtml.length > 0 ||
    templateBlocks.some((block) => isTooLargeInsightTemplateBlock(block.text));
  const fallbackText =
    attachments.length > 0
      ? 'Please review the attached file(s).'
      : insightTemplate
        ? 'Create an insight from the attached template.'
        : 'Tell me about the selected part of the insight.';
  // Recorded on the message, never sent to the model: the attachment refs
  // for a later handoff, and the selection so a reloaded chat can re-render
  // its chip.
  const additionalKwargs = {
    ...(attachments.length > 0
      ? { [CHAT_ATTACHMENTS_KWARG]: chatAttachmentService.ownedRefs(attachments) }
      : {}),
    ...(insightSelection ? { [INSIGHT_SELECTION_KWARG]: insightSelection } : {}),
  };
  return {
    messages: [
      new HumanMessage({
        content: [
          ...templateBlocks,
          ...(insightSelection
            ? [{ type: 'text' as const, text: formatInsightSelectionBlock(insightSelection) }]
            : []),
          { type: 'text', text: userText || fallbackText },
          ...blocks,
        ],
        ...(Object.keys(additionalKwargs).length > 0
          ? { additional_kwargs: additionalKwargs }
          : {}),
      }),
    ],
    uploadedFileIds: fileIds,
    carriesTooLargeDocument,
  };
}
