import { describe, it, expect } from 'vitest';
import { offerOptions } from './offer_options';
import { extractApprovalPayload } from '@/lib/insights/approvalMarker';
import { OPTION_CARD_MARKER, type OptionCardPayload } from '@/lib/chat/optionCards';

describe('offer_options', () => {
  it('hands the transcript an option card and tells the bot to stop and wait', async () => {
    const out = (await offerOptions.invoke({
      question: 'Which markets?',
      mode: 'multi',
      options: [{ label: 'Indonesia', recommended: true }, { label: 'Vietnam', description: 'Smaller deal flow' }],
    })) as string;

    const card = extractApprovalPayload<OptionCardPayload>(out, OPTION_CARD_MARKER);
    expect(card).toMatchObject({
      question: 'Which markets?',
      mode: 'multi',
      allow_custom: true,
      options: [{ label: 'Indonesia', recommended: true }, { label: 'Vietnam', description: 'Smaller deal flow' }],
    });
    expect(card?.card_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out).toContain('End your reply now');
  });

  it('turns an invalid card into a rejection the bot can fix', async () => {
    const out = await offerOptions.invoke({
      question: 'Pick',
      options: [
        { label: 'A', recommended: true },
        { label: 'B', recommended: true },
      ],
    });
    expect(out).toBe('Rejection: Recommend at most one option');
  });
});
