import { describe, it, expect, vi } from 'vitest';
import {
  buildReclassifyPrompt,
  parseReclassifyResponse,
  classifyStoredNotes,
  blankEmailNotes,
  restoreEmailNotes,
  reclassifyEmailNotes,
  RECLASSIFY_MODEL,
  type StoredEmailNote,
} from './emailNoteReclassify';
import { DEAL_NOTE_RUBRIC } from '../mboxParser/llmEnrich';

function note(overrides: Partial<StoredEmailNote> = {}): StoredEmailNote {
  return {
    email_id: '00000000-0000-0000-0000-000000000001',
    summary: 'Banker shared the Project Titan teaser.',
    key_points: [],
    next_step: null,
    next_step_status: 'none',
    ...overrides,
  };
}

/** A client whose reply marks the listed batch indices as not deal-related. */
function clientDropping(...dropIndices: number[]) {
  return {
    messages: {
      create: vi.fn(async (req: { messages: { content: string }[] }) => {
        const count = (req.messages[0].content.match(/^\[\d+\] summary:/gm) ?? []).length;
        const verdicts = Array.from({ length: count }, (_, index) => ({
          index,
          is_deal_related: !dropIndices.includes(index),
        }));
        return { content: [{ type: 'text', text: JSON.stringify(verdicts) }] };
      }),
    },
  };
}

/** A db whose SELECTs hand out `pages` in order; records every statement. */
function dbServing(pages: StoredEmailNote[][]) {
  const executed: string[] = [];
  let page = 0;
  const execute = vi.fn(async (query: unknown) => {
    const text = JSON.stringify(query);
    executed.push(text);
    if (text.includes('UPDATE analytics.email_notes')) return { rows: [] };
    return { rows: pages[page++] ?? [] };
  });
  return { db: { execute } as never, executed };
}

describe('buildReclassifyPrompt', () => {
  it('numbers each note so the model can key its answers by index', () => {
    const prompt = buildReclassifyPrompt([note(), note({ summary: 'Second' })]);
    expect(prompt).toContain('[0] summary:');
    expect(prompt).toContain('[1] summary:');
  });

  it('judges against the same rubric the extraction prompt uses', () => {
    expect(buildReclassifyPrompt([note()])).toContain(DEAL_NOTE_RUBRIC);
  });

  it('fences note text as untrusted content', () => {
    const prompt = buildReclassifyPrompt([
      note({ key_points: ['a', 'b'], next_step: 'Sign the NDA' }),
    ]);
    expect(prompt).toContain('<<<NOTE>>>Banker shared the Project Titan teaser.<<<END_NOTE>>>');
    expect(prompt).toContain('<<<NOTE>>>a | b<<<END_NOTE>>>');
    expect(prompt).toContain('<<<NOTE>>>Sign the NDA<<<END_NOTE>>>');
  });
});

describe('parseReclassifyResponse', () => {
  it('reads verdicts from a fenced array', () => {
    const text = '```json\n[{"index":0,"is_deal_related":false},{"index":1,"is_deal_related":true}]\n```';
    expect([...parseReclassifyResponse(text, 2)]).toEqual([
      [0, false],
      [1, true],
    ]);
  });

  it('ignores out-of-range indices and non-boolean verdicts', () => {
    const text =
      '[{"index":5,"is_deal_related":false},{"index":0,"is_deal_related":"false"},{"index":1}]';
    expect(parseReclassifyResponse(text, 2).size).toBe(0);
  });

  it('keeps the first verdict when an index repeats', () => {
    const text = '[{"index":0,"is_deal_related":true},{"index":0,"is_deal_related":false}]';
    expect(parseReclassifyResponse(text, 1).get(0)).toBe(true);
  });

  it('returns no verdicts for prose or broken JSON', () => {
    expect(parseReclassifyResponse('no idea', 1).size).toBe(0);
    expect(parseReclassifyResponse('[{"index":0,', 1).size).toBe(0);
  });
});

describe('classifyStoredNotes', () => {
  it('asks Haiku at low effort', async () => {
    const client = clientDropping();
    await classifyStoredNotes([note()], { client: client as never });
    expect(client.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: RECLASSIFY_MODEL, output_config: { effort: 'low' } }),
    );
  });

  it('returns no verdicts when the call fails, so the batch is kept', async () => {
    const client = { messages: { create: vi.fn().mockRejectedValue(new Error('overloaded')) } };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await classifyStoredNotes([note()], { client: client as never })).size).toBe(0);
    errSpy.mockRestore();
  });

  it('does not call the model for an empty batch', async () => {
    const client = clientDropping();
    await classifyStoredNotes([], { client: client as never });
    expect(client.messages.create).not.toHaveBeenCalled();
  });
});

describe('blankEmailNotes', () => {
  it('returns 0 without hitting the DB when the id list is empty', async () => {
    const execute = vi.fn();
    expect(await blankEmailNotes({ execute } as never, [])).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('blanks the notes into the non-deal shape in one statement', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ email_id: 'a' }, { email_id: 'b' }] });
    expect(await blankEmailNotes({ execute } as never, ['a', 'b'])).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(execute.mock.calls[0][0]);
    expect(text).toContain('summary = NULL');
    expect(text).toContain("next_step_status = 'none'");
    expect(text).toContain('AND summary IS NOT NULL');
  });
});

describe('restoreEmailNotes', () => {
  it('returns 0 without hitting the DB when there is nothing to restore', async () => {
    const execute = vi.fn();
    expect(await restoreEmailNotes({ execute } as never, [])).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('restores every backed-up note in one statement, only where still blank', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ email_id: 'a' }] });
    const restored = await restoreEmailNotes({ execute } as never, [
      note({ key_points: ['Bids due Friday'], next_step: 'Sign the NDA', next_step_status: 'action' }),
    ]);
    expect(restored).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(execute.mock.calls[0][0]);
    expect(text).toContain('Banker shared the Project Titan teaser.');
    expect(text).toContain('Bids due Friday');
    expect(text).toContain('AND n.summary IS NULL');
  });
});

describe('reclassifyEmailNotes', () => {
  const titan = note({ email_id: '00000000-0000-0000-0000-00000000000a' });
  const meeting = note({
    email_id: '00000000-0000-0000-0000-00000000000b',
    summary: 'Agreed to meet at the office on Thursday.',
  });

  it('writes nothing on a dry run but still reports what it would drop', async () => {
    const { db, executed } = dbServing([[titan, meeting]]);
    const onDropped = vi.fn();
    const result = await reclassifyEmailNotes(
      db,
      { apply: false, onDropped },
      { client: clientDropping(1) as never },
    );
    expect(result).toMatchObject({ examined: 2, kept: 1, dropped: 1, unclassified: 0 });
    expect(onDropped).toHaveBeenCalledWith([meeting]);
    expect(executed.some((q) => q.includes('UPDATE'))).toBe(false);
  });

  it('blanks only the notes judged not deal-related, after handing them to onDropped', async () => {
    const { db, executed } = dbServing([[titan, meeting]]);
    const order: string[] = [];
    const onDropped = vi.fn(() => {
      order.push(`dropped:${executed.length}`);
    });
    const result = await reclassifyEmailNotes(
      db,
      { apply: true, onDropped },
      { client: clientDropping(1) as never },
    );
    const updates = executed.filter((q) => q.includes('UPDATE analytics.email_notes'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(meeting.email_id);
    expect(updates[0]).not.toContain(titan.email_id);
    // onDropped ran before the UPDATE was issued (only the first SELECT had run).
    expect(order).toEqual(['dropped:1']);
    expect(result.cursor).toBe(meeting.email_id);
  });

  it('keeps every note when Haiku returns no verdict', async () => {
    const { db, executed } = dbServing([[titan, meeting]]);
    const client = { messages: { create: vi.fn().mockResolvedValue({ content: [] }) } };
    const result = await reclassifyEmailNotes(db, { apply: true }, { client: client as never });
    expect(result).toMatchObject({ examined: 2, kept: 2, dropped: 0, unclassified: 2 });
    expect(executed.some((q) => q.includes('UPDATE'))).toBe(false);
  });

  it('pages by email_id and stops at the limit', async () => {
    const { db, executed } = dbServing([[titan], [meeting]]);
    const result = await reclassifyEmailNotes(
      db,
      { apply: false, limit: 1, after: '00000000-0000-0000-0000-000000000000' },
      { client: clientDropping() as never },
    );
    expect(result).toMatchObject({ examined: 1, cursor: titan.email_id });
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('00000000-0000-0000-0000-000000000000');
  });
});
