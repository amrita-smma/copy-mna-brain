import { describe, expect, it } from 'vitest';
import {
  proposeInsightCreate,
  INSIGHT_CREATE_APPROVAL_MARKER,
} from '@/lib/agents/analysis/tools/propose_insight_create';
import {
  proposeInsightEdit,
  INSIGHT_EDIT_APPROVAL_MARKER,
} from '@/lib/agents/analysis/tools/propose_insight_edit';
import {
  extractApprovalPayload,
  resolveApprovalPayload,
  stripApprovalMarkers,
} from './approvalMarker';
import { ADVERSARIAL_DOCUMENT } from './__testHelpers';

import type {
  InsightCreateApprovalPayload,
  InsightEditApprovalPayload,
} from './types';

/**
 * The seam between the `propose_*` tools (server) and `ChatMessageBubble`
 * (client), which are separate modules that must agree on one wire format.
 *
 * It is tested end to end because the document is arbitrary unsanitized HTML:
 * the tool's own unit tests assert on its return string, and the component's
 * assert on a hand-written fixture, so a format change can pass both while the
 * real pair stops agreeing. The bubble calls exactly the two functions used
 * here.
 */

const SEAM_CASES = [
  {
    toolName: 'propose_insight_create',
    tool: proposeInsightCreate,
    marker: INSIGHT_CREATE_APPROVAL_MARKER,
    input: { name: 'Sector Brief', description: 'APAC semiconductor equipment', html: ADVERSARIAL_DOCUMENT },
    assertPayload: (payload: InsightCreateApprovalPayload) => expect(payload.name).toBe('Sector Brief'),
  },
  {
    toolName: 'propose_insight_edit',
    tool: proposeInsightEdit,
    marker: INSIGHT_EDIT_APPROVAL_MARKER,
    input: {
      insight_id: '11111111-2222-3333-4444-555555555555',
      summary: 'Refreshed the revenue chart',
      html: ADVERSARIAL_DOCUMENT,
    },
    assertPayload: (payload: InsightEditApprovalPayload) =>
      expect(payload.insight_id).toBe('11111111-2222-3333-4444-555555555555'),
  },
];

describe.each(SEAM_CASES)(
  'insight approval seam: $toolName -> chat bubble',
  ({ tool, marker, input, assertPayload }) => {
    it('delivers the document byte-for-byte and leaves no document bytes in the prose', async () => {
      const reply = (await (tool as any).invoke(input)) as string;
      const markerPayload = extractApprovalPayload<any>(reply, marker);

      expect(markerPayload).not.toBeNull();
      // The marker does not carry html; the card resolves it from the tool args.
      expect(markerPayload!.html).toBeUndefined();
      const payload = resolveApprovalPayload<any>(markerPayload, input);
      // Byte-for-byte: this document is published exactly as the model wrote it.
      expect(payload!.html).toBe(ADVERSARIAL_DOCUMENT);
      assertPayload(payload!);

      // The regression: a payload that ends its own HTML comment early leaves the
      // rest of a multi-kilobyte document rendering as chat text.
      const prose = stripApprovalMarkers(reply);
      expect(prose.trim()).not.toBe('');
      expect(prose).not.toContain('DOCTYPE');
      expect(prose).not.toContain('cdn.jsdelivr.net');
      expect(prose).not.toContain(marker);
    });
  },
);
