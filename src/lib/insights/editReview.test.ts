import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REJECT_RESOLUTION_TEXT,
  baseMovedMessage,
  createInsightEditActions,
  editCandidate,
  editScopeText,
  hasBaseMoved,
  nextBaseMove,
  versionTriggerPhrase,
} from './editReview';

describe('hasBaseMoved', () => {
  it('is true only when a known head differs from the version diffed against', () => {
    expect(hasBaseMoved(3, { version_no: 4 })).toBe(true);
    expect(hasBaseMoved(3, { version_no: 3 })).toBe(false);
    expect(hasBaseMoved(null, { version_no: 4 })).toBe(false);
    expect(hasBaseMoved(3, null)).toBe(false);
    expect(hasBaseMoved(undefined, undefined)).toBe(false);
  });
});

describe('nextBaseMove', () => {
  const head = { version_no: 5, created_at: '2026-09-24 03:00:00+00', trigger: 'routine' };

  it('reports the move from the first diffed version to the refetched one', () => {
    expect(nextBaseMove(3, { version_no: 5 }, head)).toEqual({
      fromVersionNo: 3,
      toVersionNo: 5,
      publishedAt: head.created_at,
      trigger: 'routine',
    });
  });

  it('reports no move when the refetched version is the first one', () => {
    expect(nextBaseMove(3, { version_no: 3 }, head)).toBeNull();
  });

  it('does not borrow the head of a different version than the one refetched', () => {
    expect(nextBaseMove(3, { version_no: 6 }, head)).toMatchObject({ toVersionNo: 6, publishedAt: '', trigger: '' });
  });
});

describe('baseMovedMessage', () => {
  const format = (iso: string) => `<${new Date(iso).toISOString()}>`;

  it('names the new version, who published it and when, and what approving does', () => {
    const text = baseMovedMessage(
      { fromVersionNo: 3, toVersionNo: 5, publishedAt: '2026-09-24 03:00:00+00', trigger: 'routine' },
      format,
    );

    expect(text).toBe(
      'This insight moved to v5 (published by a scheduled refresh at <2026-09-24T03:00:00.000Z>) since this edit was proposed — the changes below are against v5. Approving publishes this edit over v5.',
    );
  });

  it('accepts an ISO publish time and drops an unreadable one', () => {
    expect(
      baseMovedMessage({ fromVersionNo: 1, toVersionNo: 2, publishedAt: '2026-09-24T03:00:00Z', trigger: 'workforce' }, format),
    ).toContain('published by an AI Workforce run at <2026-09-24T03:00:00.000Z>');
    expect(
      baseMovedMessage({ fromVersionNo: 1, toVersionNo: 2, publishedAt: 'not a date', trigger: 'x' }, format),
    ).toContain('(published by another change)');
  });
});

describe('versionTriggerPhrase', () => {
  it('describes each trigger in words', () => {
    expect(versionTriggerPhrase('routine')).toBe('a scheduled refresh');
    expect(versionTriggerPhrase('copilot_edit')).toBe('another approved CoPilot edit');
    expect(versionTriggerPhrase('rollback')).toBe('a rollback');
    expect(versionTriggerPhrase('upload')).toBe('a new version');
  });
});

describe('createInsightEditActions', () => {
  const fetchMock = vi.fn();
  const publishInsightVersion = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    publishInsightVersion.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reject writes nothing: no publish, no request of any kind', () => {
    const actions = createInsightEditActions({ publishInsightVersion });

    expect(actions.reject()).toBe(REJECT_RESOLUTION_TEXT);
    expect(publishInsightVersion).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('approve publishes the untouched candidate over the version the user reviewed', async () => {
    publishInsightVersion.mockResolvedValueOnce({ version_no: 6 });
    const actions = createInsightEditActions({ publishInsightVersion });
    const candidate = '<section data-section="a"><p>2%</p></section>';

    const result = await actions.approve({
      insightId: 'i1',
      html: candidate,
      summary: 'Update a',
      baseVersionNo: 5,
      chatId: 'c1',
    });

    expect(result).toEqual({ version_no: 6 });
    expect(publishInsightVersion).toHaveBeenCalledWith('i1', {
      html: candidate,
      label: 'Update a',
      baseVersionNo: 5,
      chat_id: 'c1',
    });
  });

  it('approve sends the fragment and its section, so the server does the splice', async () => {
    publishInsightVersion.mockResolvedValueOnce({ version_no: 6 });
    const actions = createInsightEditActions({ publishInsightVersion });
    const fragment = '<section data-section="a"><p>2%</p></section>';

    await actions.approve({
      insightId: 'i1',
      html: fragment,
      section: 'a',
      summary: 'Update a',
      baseVersionNo: 5,
      chatId: 'c1',
    });

    expect(publishInsightVersion).toHaveBeenCalledWith('i1', {
      html: fragment,
      section: 'a',
      label: 'Update a',
      baseVersionNo: 5,
      chat_id: 'c1',
    });
  });
});

describe('editCandidate', () => {
  const current = '<body><section data-section="a"><p>1%</p></section><section data-section="b"><p>x</p></section></body>';
  const fragment = '<section data-section="a"><p>2%</p></section>';

  it('is the proposal itself for a whole-document edit, before and after the current version loads', () => {
    expect(editCandidate({ html: '<p>doc</p>' }, null)).toEqual({ html: '<p>doc</p>', error: null });
    expect(editCandidate({ html: '<p>doc</p>', section: null }, current)).toEqual({ html: '<p>doc</p>', error: null });
  });

  it('is the current version with the fragment spliced over its section', () => {
    expect(editCandidate({ html: fragment, section: 'a' }, current)).toEqual({
      html: '<body><section data-section="a"><p>2%</p></section><section data-section="b"><p>x</p></section></body>',
      error: null,
    });
  });

  it('is nothing yet while the current version is loading', () => {
    expect(editCandidate({ html: fragment, section: 'a' }, null)).toEqual({ html: null, error: null });
  });

  it('is an error when the section is gone from the current version', () => {
    const result = editCandidate({ html: fragment, section: 'a' }, '<body><section data-section="b"></section></body>');
    expect(result.html).toBeNull();
    expect(result.error).toContain('not found');
  });
});

describe('editScopeText', () => {
  it('names the section for a section edit and the whole document otherwise', () => {
    expect(editScopeText('risk-summary')).toBe('Section “risk-summary” will be replaced; the rest of the document is unchanged.');
    expect(editScopeText(null)).toBe('Whole document content will be replaced.');
    expect(editScopeText(undefined)).toBe('Whole document content will be replaced.');
  });
});
