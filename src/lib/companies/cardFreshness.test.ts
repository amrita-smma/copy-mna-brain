import { describe, expect, it } from 'vitest';
import type { Tables } from '@/lib/repositories';
import {
  buildSourceFreshnessContext,
  dealDocumentToSource,
  fileToSource,
  hasCardContent,
  isCardStale,
  latestSourceDate,
  MAX_SOURCE_CONTENT_CHARS,
  MAX_SOURCES_IN_PROMPT,
  sortSourcesByDateDesc,
  sourcesNewerThanCard,
  type CardSourceDocument,
} from './cardFreshness';

function source(overrides: Partial<CardSourceDocument> = {}): CardSourceDocument {
  return {
    kind: 'file',
    id: 'src-1',
    name: 'doc.pdf',
    date: '2026-01-01T00:00:00.000Z',
    label: null,
    content: 'Revenue was $50M.',
    ...overrides,
  };
}

function dealDoc(overrides: Partial<Tables<'deal_documents'>> = {}): Tables<'deal_documents'> {
  return {
    id: 'doc-1',
    deal_id: 'company-1',
    file_name: 'IC memo.pdf',
    file_path: 'deals/company-1/ic-memo.pdf',
    file_size: 1024,
    mime_type: 'application/pdf',
    stage: 'L2',
    created_at: '2026-03-01T00:00:00.000Z',
    raw_notes: 'raw text',
    structured_notes: 'structured text',
    tags: [],
    processing_status: 'completed',
    ...overrides,
  } as Tables<'deal_documents'>;
}

function file(overrides: Partial<Tables<'files'>> = {}): Tables<'files'> {
  return {
    id: 'file-1',
    file_name: 'MoM Jan.pdf',
    file_link: 'https://example.com/mom.pdf',
    raw_notes: 'raw file text',
    structured_notes: 'structured file text',
    created_at: '2026-02-10T00:00:00.000Z',
    updated_at: '2026-02-10T00:00:00.000Z',
    tags: [],
    processing_status: 'completed',
    matched_companies: [],
    file_date: '2026-02-01',
    file_type: 'mom',
    origin_email: false,
    drop_reason: null,
    workspace_id: 'workspace-1',
    ...overrides,
  } as Tables<'files'>;
}

describe('hasCardContent', () => {
  const empty = {
    business_overview: null,
    business_model_summary: null,
    key_takeaways: null,
    investment_highlights: null,
    investment_risks: null,
    diligence_priorities: null,
  };

  it('is false for a row with no populated section', () => {
    // `created_at` defaults to NOW() on the status:'processing' insert, so a
    // run that failed before writing anything leaves a dated but empty row.
    // Only the sections can tell us there is no card here.
    expect(hasCardContent(empty)).toBe(false);
  });

  it('is false for a missing row', () => {
    expect(hasCardContent(null)).toBe(false);
    expect(hasCardContent(undefined)).toBe(false);
  });

  it('is false when every section is only whitespace', () => {
    expect(hasCardContent({ ...empty, business_overview: '   \n ' })).toBe(false);
  });

  it('is true as soon as any one section carries content', () => {
    expect(hasCardContent({ ...empty, diligence_priorities: '1. What is the churn?' })).toBe(
      true,
    );
  });
});

describe('dealDocumentToSource', () => {
  it('dates a deal document by created_at and prefers structured notes', () => {
    expect(dealDocumentToSource(dealDoc())).toEqual({
      kind: 'deal_document',
      id: 'doc-1',
      name: 'IC memo.pdf',
      date: '2026-03-01T00:00:00.000Z',
      label: 'stage L2',
      content: 'structured text',
    });
  });

  it('falls back to raw notes when the document has no structured notes', () => {
    expect(dealDocumentToSource(dealDoc({ structured_notes: null })).content).toBe('raw text');
  });

  it('reports null content when the document has no extracted text at all', () => {
    expect(
      dealDocumentToSource(dealDoc({ structured_notes: null, raw_notes: '  ' })).content,
    ).toBeNull();
  });

  it('truncates oversized content so the prompt stays bounded', () => {
    const long = 'x'.repeat(MAX_SOURCE_CONTENT_CHARS + 500);
    const content = dealDocumentToSource(dealDoc({ structured_notes: long })).content!;
    expect(content.length).toBeLessThan(long.length);
    expect(content.endsWith('… [truncated]')).toBe(true);
  });
});

describe('fileToSource', () => {
  it('dates a file by its business file_date, not its upload time', () => {
    expect(fileToSource(file())).toEqual({
      kind: 'file',
      id: 'file-1',
      name: 'MoM Jan.pdf',
      date: '2026-02-01',
      label: 'mom',
      content: 'structured file text',
    });
  });

  it('falls back to created_at when the extractor found no file_date', () => {
    expect(fileToSource(file({ file_date: null })).date).toBe('2026-02-10T00:00:00.000Z');
  });

  it('leaves the date null when the file has neither date', () => {
    expect(fileToSource(file({ file_date: null, created_at: null })).date).toBeNull();
  });
});

describe('sortSourcesByDateDesc', () => {
  it('orders newest first and pushes undated documents to the end', () => {
    const sorted = sortSourcesByDateDesc([
      source({ id: 'old', date: '2025-01-01T00:00:00.000Z' }),
      source({ id: 'undated', date: null }),
      source({ id: 'new', date: '2026-06-01T00:00:00.000Z' }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(['new', 'old', 'undated']);
  });

  it('does not mutate the input array', () => {
    const input = [
      source({ id: 'a', date: '2025-01-01T00:00:00.000Z' }),
      source({ id: 'b', date: '2026-01-01T00:00:00.000Z' }),
    ];
    sortSourcesByDateDesc(input);
    expect(input.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('latestSourceDate', () => {
  it('returns the most recent date across the sources', () => {
    expect(
      latestSourceDate([
        source({ date: '2025-01-01T00:00:00.000Z' }),
        source({ date: '2026-06-01T00:00:00.000Z' }),
        source({ date: null }),
      ]),
    ).toBe('2026-06-01T00:00:00.000Z');
  });

  it('returns null when nothing is dated', () => {
    expect(latestSourceDate([source({ date: null })])).toBeNull();
    expect(latestSourceDate([])).toBeNull();
  });

  it('ignores unparseable dates rather than returning them', () => {
    expect(latestSourceDate([source({ date: 'not-a-date' })])).toBeNull();
  });
});

describe('sourcesNewerThanCard', () => {
  const sources = [
    source({ id: 'before', date: '2026-01-01T00:00:00.000Z' }),
    source({ id: 'after', date: '2026-05-01T00:00:00.000Z' }),
    source({ id: 'undated', date: null }),
  ];

  it('returns only documents dated strictly after the card', () => {
    const newer = sourcesNewerThanCard(sources, '2026-03-01T00:00:00.000Z');
    expect(newer.map((s) => s.id)).toEqual(['after']);
  });

  it('treats a document dated exactly at the card timestamp as not newer', () => {
    const newer = sourcesNewerThanCard(sources, '2026-05-01T00:00:00.000Z');
    expect(newer).toEqual([]);
  });

  it('counts every dated document as newer when no card has been generated yet', () => {
    const newer = sourcesNewerThanCard(sources, null);
    expect(newer.map((s) => s.id)).toEqual(['before', 'after']);
  });
});

describe('date-only sources (files.file_date)', () => {
  // A `date` column has no time. Anchoring it at midnight would make a file
  // "as of" today lose to a card generated at 09:00 today, even though the
  // file was uploaded afterwards — so a date-only source covers its whole day.
  it('counts a file dated the same calendar day as the card as newer', () => {
    const newer = sourcesNewerThanCard(
      [source({ id: 'today', date: '2026-03-01' })],
      '2026-03-01T09:00:00.000Z',
    );
    expect(newer.map((s) => s.id)).toEqual(['today']);
  });

  it('still counts a file dated the day before as older', () => {
    const newer = sourcesNewerThanCard(
      [source({ id: 'yesterday', date: '2026-02-28' })],
      '2026-03-01T09:00:00.000Z',
    );
    expect(newer).toEqual([]);
  });

  it('renders the calendar day it was given, not the end-of-day instant', () => {
    const context = buildSourceFreshnessContext({
      sources: [source({ name: 'MoM.pdf', date: '2026-03-01' })],
      generatedAt: null,
    });
    expect(context).toContain('MoM.pdf (2026-03-01');
  });

  it('ranks sources against each other on the raw instant, not the end of day', () => {
    // End-of-day is only how a date-only source is weighed against the card.
    // Applying it here would put a file dated 2026-03-01 above a deal document
    // actually created at 22:00 that day, inverting "later-dated source wins".
    const sorted = sortSourcesByDateDesc([
      source({ id: 'date-only', date: '2026-03-01' }),
      source({ id: 'evening', date: '2026-03-01T22:00:00.000Z' }),
      source({ id: 'previous-day', date: '2026-02-28T22:00:00.000Z' }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(['evening', 'date-only', 'previous-day']);
  });

  it('reports the raw instant as the latest source date', () => {
    expect(
      latestSourceDate([
        source({ date: '2026-03-01' }),
        source({ date: '2026-03-01T22:00:00.000Z' }),
      ]),
    ).toBe('2026-03-01T22:00:00.000Z');
  });
});

describe('isCardStale', () => {
  it('is stale when a document postdates the card', () => {
    expect(
      isCardStale([source({ date: '2026-05-01T00:00:00.000Z' })], '2026-01-01T00:00:00.000Z'),
    ).toBe(true);
  });

  it('is not stale when every document predates the card', () => {
    expect(
      isCardStale([source({ date: '2025-05-01T00:00:00.000Z' })], '2026-01-01T00:00:00.000Z'),
    ).toBe(false);
  });

  it('is stale when no card has ever been generated', () => {
    expect(isCardStale([], null)).toBe(true);
  });

  it('is not stale when the card exists and there are no documents', () => {
    expect(isCardStale([], '2026-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('buildSourceFreshnessContext', () => {
  it('returns an empty string for a first generation with no documents', () => {
    expect(buildSourceFreshnessContext({ sources: [], generatedAt: null })).toBe('');
  });

  it('states the card date and marks documents that postdate it as overriding', () => {
    const context = buildSourceFreshnessContext({
      sources: [
        source({ id: 'newer', name: 'Q1 update.pdf', date: '2026-05-01T00:00:00.000Z' }),
        source({ id: 'older', name: 'Old teaser.pdf', date: '2025-05-01T00:00:00.000Z' }),
      ],
      generatedAt: '2026-01-15T00:00:00.000Z',
    });

    expect(context).toContain('generated on **2026-01-15**');
    expect(context).toMatch(/Q1 update\.pdf \(2026-05-01\).*NEWER than the existing card/);
    expect(context).toMatch(/Old teaser\.pdf \(2025-05-01\).*the card wins on conflict/);
  });

  it('spells out the later-date-wins rule', () => {
    const context = buildSourceFreshnessContext({
      sources: [source()],
      generatedAt: '2026-01-15T00:00:00.000Z',
    });
    expect(context).toContain('the one with the later date wins');
    expect(context).toContain('overrides what the card says');
    expect(context).toContain('An **undated** document can never win a conflict');
  });

  it('says there is no previous card when the company has never been analysed', () => {
    const context = buildSourceFreshnessContext({ sources: [source()], generatedAt: null });
    expect(context).toContain('no previously generated Company Card content');
    // With nothing to compare against, per-document recency labels are noise.
    expect(context).not.toContain('NEWER than the existing card');
  });

  it('lists newest documents first and caps how many reach the prompt', () => {
    const many = Array.from({ length: MAX_SOURCES_IN_PROMPT + 5 }, (_, i) =>
      source({
        id: `src-${i}`,
        name: `doc-${i}.pdf`,
        // Descending dates: doc-0 newest.
        date: new Date(Date.UTC(2026, 0, 1) - i * 86_400_000).toISOString(),
      }),
    );
    const context = buildSourceFreshnessContext({ sources: many, generatedAt: null });

    expect(context).toContain('doc-0.pdf');
    expect(context).toContain(`doc-${MAX_SOURCES_IN_PROMPT - 1}.pdf`);
    expect(context).not.toContain(`doc-${MAX_SOURCES_IN_PROMPT}.pdf`);
    expect(context.indexOf('doc-0.pdf')).toBeLessThan(context.indexOf('doc-1.pdf'));
  });

  it('notes when the company has no documents on record', () => {
    const context = buildSourceFreshnessContext({
      sources: [],
      generatedAt: '2026-01-15T00:00:00.000Z',
    });
    expect(context).toContain('No deal documents or matched files are on record');
  });

  it('flags a document with no extracted content instead of pretending it is empty', () => {
    const context = buildSourceFreshnessContext({
      sources: [source({ content: null })],
      generatedAt: null,
    });
    expect(context).toContain('No extracted content available');
  });

  it('labels an undated document rather than dropping it', () => {
    const context = buildSourceFreshnessContext({
      sources: [source({ name: 'mystery.pdf', date: null })],
      generatedAt: '2026-01-15T00:00:00.000Z',
    });
    expect(context).toContain('mystery.pdf (undated)');
  });

  it('inlines the previous card so still-valid findings can be carried forward', () => {
    const context = buildSourceFreshnessContext({
      sources: [source()],
      generatedAt: '2026-01-15T00:00:00.000Z',
      previousCard: {
        business_overview: '- Makes widgets',
        business_model_summary: null,
        key_takeaways: '1. Solid margins',
        investment_highlights: null,
        investment_risks: null,
        diligence_priorities: null,
      },
    });

    expect(context).toContain('Existing card content (as of 2026-01-15)');
    expect(context).toContain('- Makes widgets');
    expect(context).toContain('1. Solid margins');
    // Empty sections are skipped rather than emitted as blank headers.
    expect(context).not.toContain('Investment Highlights');
  });

  it('omits the previous card block when there is no card date to anchor it', () => {
    const context = buildSourceFreshnessContext({
      sources: [source()],
      generatedAt: null,
      previousCard: {
        business_overview: '- Makes widgets',
        business_model_summary: null,
        key_takeaways: null,
        investment_highlights: null,
        investment_risks: null,
        diligence_priorities: null,
      },
    });
    expect(context).not.toContain('Existing card content');
  });
});
