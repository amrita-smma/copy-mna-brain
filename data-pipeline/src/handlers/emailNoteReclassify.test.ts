import { describe, it, expect, vi } from 'vitest';
import {
  buildReclassifyPrompt,
  parseReclassifyResponse,
  classifyStoredNotes,
  blankEmailNotes,
  rewriteEmailNotes,
  restoreEmailNotes,
  reclassifyEmailNotes,
  RECLASSIFY_MODEL,
  type StoredEmailNote,
} from './emailNoteReclassify';
import { DEAL_NOTE_RUBRIC, MEETING_NOTE_RULE } from '../mboxParser/llmEnrich';

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

/**
 * A client whose reply marks the listed batch indices as not deal-related and
 * attaches the given rewrites by index.
 */
function clientDropping(dropIndices: number[] = [], rewrites: Record<number, unknown> = {}) {
  return {
    messages: {
      create: vi.fn(async (req: { messages: { content: string }[] }) => {
        const count = (req.messages[0].content.match(/^\[\d+\] summary:/gm) ?? []).length;
        const verdicts = Array.from({ length: count }, (_, index) => ({
          index,
          is_deal_related: !dropIndices.includes(index),
          ...(rewrites[index] ? { rewrite: rewrites[index] } : {}),
        }));
        return { content: [{ type: 'text', text: JSON.stringify(verdicts) }] };
      }),
    },
  };
}

const shanghaiMeeting = note({
  email_id: '00000000-0000-0000-0000-00000000000c',
  summary: 'Approached a law firm about counsel on a gases acquisition and proposed meeting at its Shanghai office tomorrow afternoon.',
  key_points: ['Seeking the firm as counsel', 'Meeting at the Shanghai office tomorrow afternoon'],
  next_step: 'Recipient to confirm whether the Shanghai meeting works',
  next_step_status: 'action',
});

const shanghaiRewrite = {
  summary: 'Approached a law firm about counsel on a gases acquisition and proposed meeting to discuss.',
  key_points: ['Seeking the firm as counsel'],
  next_step: "Await the firm's response on advising the deal",
  next_step_status: 'action',
};

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

  it('judges against the same rubric and meeting rule the extraction prompt uses', () => {
    const prompt = buildReclassifyPrompt([note()]);
    expect(prompt).toContain(DEAL_NOTE_RUBRIC);
    expect(prompt).toContain(MEETING_NOTE_RULE);
    expect(prompt).toContain('"rewrite"');
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
      [0, { dealRelated: false }],
      [1, { dealRelated: true }],
    ]);
  });

  it('reads a rewrite on a deal-related note', () => {
    const text = JSON.stringify([{ index: 0, is_deal_related: true, rewrite: shanghaiRewrite }]);
    expect(parseReclassifyResponse(text, 1).get(0)).toEqual({
      dealRelated: true,
      rewrite: shanghaiRewrite,
    });
  });

  it('ignores a rewrite on a note judged not deal-related, so the drop wins', () => {
    const text = JSON.stringify([{ index: 0, is_deal_related: false, rewrite: shanghaiRewrite }]);
    expect(parseReclassifyResponse(text, 1).get(0)).toEqual({ dealRelated: false });
  });

  it('keeps the note as it is when the rewrite has no summary', () => {
    const text = JSON.stringify([
      { index: 0, is_deal_related: true, rewrite: { summary: null, key_points: [] } },
      { index: 1, is_deal_related: true, rewrite: 'drop the meeting' },
    ]);
    const verdicts = parseReclassifyResponse(text, 2);
    expect(verdicts.get(0)).toEqual({ dealRelated: true });
    expect(verdicts.get(1)).toEqual({ dealRelated: true });
  });

  it('normalises a rewrite like an extracted note', () => {
    const text = JSON.stringify([
      {
        index: 0,
        is_deal_related: true,
        rewrite: {
          summary: '  Gave terms.  ',
          key_points: ['a', 'b', 'c', 'd', 'e'],
          next_step: null,
          next_step_status: 'action',
        },
      },
    ]);
    expect(parseReclassifyResponse(text, 1).get(0)?.rewrite).toEqual({
      summary: 'Gave terms.',
      key_points: ['a', 'b', 'c', 'd'],
      next_step: null,
      next_step_status: 'none',
    });
  });

  it('ignores out-of-range indices and non-boolean verdicts', () => {
    const text =
      '[{"index":5,"is_deal_related":false},{"index":0,"is_deal_related":"false"},{"index":1}]';
    expect(parseReclassifyResponse(text, 2).size).toBe(0);
  });

  it('keeps the first verdict when an index repeats', () => {
    const text = '[{"index":0,"is_deal_related":true},{"index":0,"is_deal_related":false}]';
    expect(parseReclassifyResponse(text, 1).get(0)).toEqual({ dealRelated: true });
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

  it('logs a reply cut off at max_tokens', async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          stop_reason: 'max_tokens',
          content: [{ type: 'text', text: '[{"index":0,"is_deal_related":true,"rewrite":{"summary":"Ga' }],
        }),
      },
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await classifyStoredNotes([note()], { client: client as never })).size).toBe(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('max_tokens'));
    errSpy.mockRestore();
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

describe('rewriteEmailNotes', () => {
  it('returns 0 without hitting the DB when there is nothing to rewrite', async () => {
    const execute = vi.fn();
    expect(await rewriteEmailNotes({ execute } as never, [])).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rewrites in one statement, only where the judged summary is still there', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ email_id: 'c' }] });
    const rewritten = await rewriteEmailNotes({ execute } as never, [
      {
        original: shanghaiMeeting,
        rewritten: { email_id: shanghaiMeeting.email_id, ...shanghaiRewrite } as StoredEmailNote,
      },
    ]);
    expect(rewritten).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(execute.mock.calls[0][0]);
    expect(text).toContain(shanghaiRewrite.summary);
    expect(text).toContain(shanghaiMeeting.summary);
    expect(text).toContain('AND n.summary = v.judged_summary');
  });
});

describe('restoreEmailNotes', () => {
  it('returns 0 without hitting the DB when there is nothing to restore', async () => {
    const execute = vi.fn();
    expect(await restoreEmailNotes({ execute } as never, [])).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('restores blanked and rewritten notes in one statement, only where unchanged since', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ email_id: 'a' }, { email_id: 'c' }] });
    const restored = await restoreEmailNotes({ execute } as never, [
      {
        note: note({ key_points: ['Bids due Friday'], next_step: 'Sign the NDA', next_step_status: 'action' }),
        current_summary: null,
      },
      { note: shanghaiMeeting, current_summary: shanghaiRewrite.summary },
    ]);
    expect(restored).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const text = JSON.stringify(execute.mock.calls[0][0]);
    expect(text).toContain('Banker shared the Project Titan teaser.');
    expect(text).toContain('Bids due Friday');
    expect(text).toContain(shanghaiRewrite.summary);
    expect(text).toContain('AND n.summary IS NOT DISTINCT FROM v.current_summary');
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
      { client: clientDropping([1]) as never },
    );
    expect(result).toMatchObject({ examined: 2, kept: 1, dropped: 1, rewritten: 0, unclassified: 0 });
    expect(onDropped).toHaveBeenCalledWith([meeting]);
    expect(executed.some((q) => q.includes('UPDATE'))).toBe(false);
  });

  it('rewrites meeting logistics out of a kept deal note, after handing it to onRewritten', async () => {
    const { db, executed } = dbServing([[titan, shanghaiMeeting]]);
    const order: string[] = [];
    const onRewritten = vi.fn(() => {
      order.push(`rewritten:${executed.length}`);
    });
    const result = await reclassifyEmailNotes(
      db,
      { apply: true, onRewritten },
      { client: clientDropping([], { 1: shanghaiRewrite }) as never },
    );
    expect(result).toMatchObject({ examined: 2, kept: 2, dropped: 0, rewritten: 1 });
    expect(onRewritten).toHaveBeenCalledWith([
      { original: shanghaiMeeting, rewritten: { email_id: shanghaiMeeting.email_id, ...shanghaiRewrite } },
    ]);
    const updates = executed.filter((q) => q.includes('UPDATE analytics.email_notes'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(shanghaiRewrite.summary);
    expect(updates[0]).not.toContain(titan.email_id);
    expect(order).toEqual(['rewritten:1']);
  });

  it('reports would-rewrite notes on a dry run without writing them', async () => {
    const { db, executed } = dbServing([[shanghaiMeeting]]);
    const onRewritten = vi.fn();
    const result = await reclassifyEmailNotes(
      db,
      { apply: false, onRewritten },
      { client: clientDropping([], { 0: shanghaiRewrite }) as never },
    );
    expect(result).toMatchObject({ rewritten: 1 });
    expect(onRewritten).toHaveBeenCalledTimes(1);
    expect(executed.some((q) => q.includes('UPDATE'))).toBe(false);
  });

  it('skips a rewrite that changes nothing', async () => {
    const { db, executed } = dbServing([[titan]]);
    const same = {
      summary: titan.summary,
      key_points: titan.key_points,
      next_step: titan.next_step,
      next_step_status: titan.next_step_status,
    };
    const result = await reclassifyEmailNotes(
      db,
      { apply: true },
      { client: clientDropping([], { 0: same }) as never },
    );
    expect(result).toMatchObject({ kept: 1, rewritten: 0 });
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
      { client: clientDropping([1]) as never },
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
