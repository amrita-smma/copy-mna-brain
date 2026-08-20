import { describe, expect, it } from 'vitest';
import {
  buildCompanyCardDeck,
  buildCompanyCardSlides,
  parseCardMarkdown,
  parseInline,
  renderBlock,
  COL_W,
  type CompanyCardCompany,
  type CompanyCardSlide,
  type CompanyCardSlideInput,
} from './companyCardSlides';
import type { PptxElement, PptxText } from './pptxElements';

const SLIDE_W_IN = 13.33;
const SLIDE_H_IN = 7.5;

const company: CompanyCardCompany = {
  target: 'Acme Chemicals',
  project_name: 'London B',
  segment: 'Mining Solutions',
  geography: 'Indonesia',
  pipeline_stage: 'L1',
  deal_type: 'minority',
  stake: null,
  deal_size: null,
  ev_2024: 1250,
  ownership: 'Carve-out from Syensqo',
  banker: 'Citibank',
  entered_by_name: 'Nico',
  advisor: null,
  is_live: null,
  nbo_date: '2026-03-04',
  source: 'inbound',
  revenue_2022_usd_mn: 700,
  revenue_2023_usd_mn: 760,
  revenue_2024_usd_mn: 810,
  ebitda_2022_usd_mn: 140,
  ebitda_2023_usd_mn: 152,
  ebitda_2024_usd_mn: 170,
};

const input = (overrides: Partial<CompanyCardSlideInput> = {}): CompanyCardSlideInput => ({
  company,
  analysis: {
    business_overview: '- **Primary Products**: Flotation reagents.',
    investment_highlights: '- **Market Position**: Leading franchise.',
    business_model_summary: '- **Core Focus**: Three niches.',
    diligence_priorities: '1. What is standalone EBITDA?',
    investment_risks: '- **Data Gaps**: No EBITDA disclosed.',
  },
  currency: 'USD',
  dealLead: 'Dicki Sujadi',
  ...overrides,
});

/** A markdown bullet list long enough to overflow any single column. */
const longMarkdown = (count: number): string =>
  Array.from(
    { length: count },
    (_, i) =>
      `- **Point ${i + 1}**: ${'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(2)}`,
  ).join('\n');

// ── Element helpers ────────────────────────────────────────────────────────

const texts = (slide: CompanyCardSlide): PptxText[] =>
  slide.elements.filter((e): e is PptxText => e.type === 'text');

/** All text on a slide, joined — for "does the card mention X" assertions. */
const slideText = (slide: CompanyCardSlide): string =>
  texts(slide).map((t) => t.text).join('\n');

const deckText = (slides: CompanyCardSlide[]): string => slides.map(slideText).join('\n');

const findText = (slide: CompanyCardSlide, needle: string): PptxText | undefined =>
  texts(slide).find((t) => t.text.includes(needle));

const overlaps = (a: PptxElement, b: PptxElement): boolean => {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  // 0.01" tolerance — adjacent boxes may share an edge.
  return ox > 0.01 && oy > 0.01;
};

describe('parseInline', () => {
  it('splits bold and italic markers into runs', () => {
    expect(parseInline('**Label**: some *aside*')).toEqual([
      { text: 'Label', bold: true, italic: undefined },
      { text: ': some ', bold: undefined, italic: undefined },
      { text: 'aside', bold: undefined, italic: true },
    ]);
  });

  it('returns a single plain run for unformatted text', () => {
    expect(parseInline('just words')).toEqual([
      { text: 'just words', bold: undefined, italic: undefined },
    ]);
  });

  it('renders code spans as plain text', () => {
    expect(parseInline('use `npm` here').map((r) => r.text).join('')).toBe('use npm here');
  });
});

describe('parseCardMarkdown', () => {
  it('returns [] for empty or whitespace-only input', () => {
    expect(parseCardMarkdown(null)).toEqual([]);
    expect(parseCardMarkdown('   \n  ')).toEqual([]);
  });

  it('classifies headings, bullets, numbered items and paragraphs', () => {
    const blocks = parseCardMarkdown(
      ['## Business model', '- first bullet', '2. second item', '', 'A closing paragraph.'].join(
        '\n',
      ),
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      'subheading',
      'bullet',
      'numbered',
      'paragraph',
    ]);
    expect(blocks[2].marker).toBe('2.');
  });

  it('folds an indented wrapped line back into the list item above it', () => {
    const blocks = parseCardMarkdown('- first bullet\n  continued here\n- second bullet');
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('first bullet continued here');
  });

  it('does not fold an indented line into a heading', () => {
    const blocks = parseCardMarkdown('## Business model\n  stray indented line');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ kind: 'subheading', text: 'Business model' });
    expect(blocks[1].kind).toBe('paragraph');
  });

  it('keeps the measured text free of markers while retaining bold runs', () => {
    const [block] = parseCardMarkdown('- **Bold**: value');
    expect(block.text).toBe('Bold: value');
    expect(block.runs[0]).toMatchObject({ text: 'Bold', bold: true });
  });
});

describe('renderBlock', () => {
  it('estimates a taller box for text that wraps to more lines', () => {
    const short = renderBlock({ kind: 'bullet', text: 'short', runs: [{ text: 'short' }] }, COL_W);
    const long = renderBlock(
      { kind: 'bullet', text: 'x'.repeat(600), runs: [{ text: 'x'.repeat(600) }] },
      COL_W,
    );
    expect(long.h).toBeGreaterThan(short.h);
  });

  it('estimates a taller box for a narrower column', () => {
    const block = { kind: 'paragraph' as const, text: 'y'.repeat(300), runs: [{ text: 'y' }] };
    expect(renderBlock(block, 120).h).toBeGreaterThan(renderBlock(block, COL_W).h);
  });

  it('renders a bullet as a separate marker and body box that do not overlap', () => {
    const piece = renderBlock({ kind: 'bullet', text: 'item', runs: [{ text: 'item' }] }, COL_W);
    const [marker, body] = piece.render(16, 100, COL_W);
    expect((marker as PptxText).text).toBe('•');
    expect(overlaps(marker, body)).toBe(false);
  });
});

describe('buildCompanyCardSlides', () => {
  it('renders a single slide carrying the whole card when content is short', () => {
    const slides = buildCompanyCardSlides(input());
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe('Acme Chemicals [Project London B] — Company Card');

    const text = slideText(slides[0]);
    // Every numbered section of the on-screen card is present.
    expect(text).toContain('Target Overview');
    expect(text).toContain('Investment Thesis');
    expect(text).toContain('Indicative Financials (USD m)');
    expect(text).toContain('Proposed Deal Structure');
    expect(text).toContain('L1 scope of work / diligence priorities');
    expect(text).toContain('Kill criteria');
    expect(text).toContain('STRICTLY PRIVATE AND CONFIDENTIAL');
  });

  it('renders the meta and deal-status boxes with resolved values', () => {
    const text = deckText(buildCompanyCardSlides(input()));
    expect(text).toContain('Geography: Indonesia');
    expect(text).toContain('Source: Inbound (Citibank)');
    expect(text).toContain('Deal Sponsor: Dicki Sujadi');
    expect(text).toContain('Deal Status: Not live');
    expect(text).toContain('NBO Due: Mar 4, 2026');
  });

  it('marks the current stage chip and leaves the others muted', () => {
    const [slide] = buildCompanyCardSlides(input());
    const active = findText(slide, 'L1')!;
    const inactive = findText(slide, 'L4')!;
    expect(active.color).toBe('FFFFFF');
    expect(inactive.color).toBe('64748B');
    // The active chip sits on a filled blue rect of its own.
    expect(
      slide.elements.some((e) => e.type === 'rect' && e.fill === '1E40AF' && overlaps(e, active)),
    ).toBe(true);
  });

  it('uses the Deal Captain label from L3 onwards', () => {
    const text = deckText(
      buildCompanyCardSlides(input({ company: { ...company, pipeline_stage: 'L3' } })),
    );
    expect(text).toContain('Deal Captain: Dicki Sujadi');
    expect(text).not.toContain('Deal Sponsor:');
  });

  it('marks the deal live and names the advisor when one is engaged', () => {
    const text = deckText(
      buildCompanyCardSlides(input({ company: { ...company, advisor: 'Rothschild' } })),
    );
    expect(text).toContain('Deal Status: Live (Rothschild)');
  });

  it('renders the financials table in the workspace currency', () => {
    const [slide] = buildCompanyCardSlides(input({ currency: 'IDR' }));
    expect(slideText(slide)).toContain('Indicative Financials (IDR m)');

    const table = slide.elements.find((e) => e.type === 'table');
    expect(table).toBeDefined();
    const cells = table!.type === 'table' ? table.rows.flat().map((c) => c.text) : [];
    expect(cells).toContain('Rp810.0M');
    // EBITDA margin = 170 / 810
    expect(cells).toContain('21.0%');
  });

  it('falls back to placeholders when the AI card has not been generated', () => {
    const text = deckText(buildCompanyCardSlides(input({ analysis: null })));
    expect(text).toContain('Target overview will appear here');
    expect(text).toContain('Investment highlights will appear here');
    expect(text).toContain('Diligence priorities will appear here');
    expect(text).toContain('Investment risks will appear here');
  });

  it('appends surfaced track variables under Indicative Financials', () => {
    const text = deckText(
      buildCompanyCardSlides(
        input({ trackVariables: [{ name: 'Recovery rate', unit: '%', value: '92' }] }),
      ),
    );
    expect(text).toContain('Recovery rate (%): 92');
  });

  it('keeps a bold lead-in label as its own run', () => {
    const [slide] = buildCompanyCardSlides(input());
    const bullet = findText(slide, 'Primary Products')!;
    expect(bullet.runs?.[0]).toMatchObject({ text: 'Primary Products', bold: true });
    expect(bullet.runs?.[1]?.bold).toBeFalsy();
  });

  it('overflows onto (cont.) slides instead of running past the slide edge', () => {
    const slides = buildCompanyCardSlides(
      input({
        analysis: {
          business_overview: longMarkdown(20),
          investment_highlights: longMarkdown(20),
          business_model_summary: longMarkdown(10),
          diligence_priorities: longMarkdown(20),
          investment_risks: longMarkdown(20),
        },
      }),
    );
    expect(slides.length).toBeGreaterThan(1);
    expect(slides[0].title).not.toContain('cont.');
    expect(slides[1].title).toContain('(cont. 1)');
    expect(slideText(slides[1])).toContain('(cont.)');
    // The fixed structural blocks stay on the first slide only.
    expect(slideText(slides[0])).toContain('Proposed Deal Structure');
    expect(slideText(slides[1])).not.toContain('Proposed Deal Structure');
  });

  it('omits the "Open in Brain" link when no companyUrl is given', () => {
    const [slide] = buildCompanyCardSlides(input());
    expect(findText(slide, 'Open in Brain')).toBeUndefined();
  });

  it('renders an "Open in Brain" footer link on every slide when companyUrl is given', () => {
    const companyUrl = 'https://app.example.com/pipeline/c1';
    const slides = buildCompanyCardSlides(
      input({
        companyUrl,
        analysis: {
          business_overview: longMarkdown(20),
          investment_highlights: longMarkdown(20),
          business_model_summary: longMarkdown(10),
          diligence_priorities: longMarkdown(20),
          investment_risks: longMarkdown(20),
        },
      }),
    );
    expect(slides.length).toBeGreaterThan(1);
    for (const slide of slides) {
      const link = findText(slide, 'Open in Brain');
      expect(link?.hyperlink).toEqual({ url: companyUrl, tooltip: 'Open in Brain' });
    }
  });

  it('never emits overlapping text boxes, on any slide', () => {
    const slides = buildCompanyCardSlides(
      input({
        analysis: {
          business_overview: longMarkdown(20),
          investment_highlights: longMarkdown(20),
          business_model_summary: longMarkdown(10),
          diligence_priorities: longMarkdown(20),
          investment_risks: longMarkdown(20),
        },
        trackVariables: [{ name: 'Recovery rate', unit: '%', value: '92' }],
      }),
    );
    for (const slide of slides) {
      const boxes = texts(slide);
      for (let a = 0; a < boxes.length; a++) {
        for (let b = a + 1; b < boxes.length; b++) {
          if (overlaps(boxes[a], boxes[b])) {
            throw new Error(
              `"${boxes[a].text.slice(0, 40)}" overlaps "${boxes[b].text.slice(0, 40)}" on "${slide.title}"`,
            );
          }
        }
      }
    }
  });

  it('keeps every shape inside the 13.33 x 7.5 inch slide', () => {
    const slides = buildCompanyCardSlides(
      input({
        analysis: {
          business_overview: longMarkdown(20),
          investment_highlights: longMarkdown(20),
          business_model_summary: longMarkdown(10),
          diligence_priorities: longMarkdown(20),
          investment_risks: longMarkdown(20),
        },
      }),
    );
    for (const slide of slides) {
      for (const el of slide.elements) {
        expect(el.x).toBeGreaterThanOrEqual(0);
        expect(el.y).toBeGreaterThanOrEqual(0);
        expect(el.x + el.w).toBeLessThanOrEqual(SLIDE_W_IN + 0.01);
        expect(el.y + el.h).toBeLessThanOrEqual(SLIDE_H_IN + 0.01);
      }
    }
  });

  it('defers a block taller than its column instead of forcing it onto the first slide', () => {
    const giant = `- ${'z'.repeat(20_000)}`;
    const slides = buildCompanyCardSlides(
      input({
        analysis: {
          business_overview: null,
          investment_highlights: null,
          business_model_summary: null,
          diligence_priorities: giant,
          investment_risks: '- **Data Gaps**: none disclosed.',
        },
      }),
    );
    expect(slideText(slides[0])).not.toContain('zzzz');
    // It still gets rendered — on a continuation slide, where it is the only
    // thing in its column and so cannot collide with anything.
    expect(deckText(slides.slice(1))).toContain('zzzz');
  });

  it('never prints a bare "Kill criteria" heading with no risks under it', () => {
    // Sweep content sizes so the column-3 split lands in many different places.
    for (let n = 1; n <= 24; n++) {
      const [first] = buildCompanyCardSlides(
        input({
          analysis: {
            business_overview: null,
            investment_highlights: null,
            business_model_summary: null,
            diligence_priorities: longMarkdown(n),
            investment_risks: longMarkdown(n).replace(/Point/g, 'Risk'),
          },
        }),
      );
      if (slideText(first).includes('Kill criteria')) {
        expect(slideText(first)).toContain('Risk 1');
      }
    }
  });

  it('gives the continued kill criteria its own unnumbered red heading', () => {
    const slides = buildCompanyCardSlides(
      input({
        analysis: {
          business_overview: null,
          investment_highlights: null,
          business_model_summary: null,
          diligence_priorities: longMarkdown(20),
          investment_risks: longMarkdown(20),
        },
      }),
    );
    const cont = slides.slice(1);
    const heading = cont.map((s) => findText(s, 'Kill criteria (cont.)')).find(Boolean)!;
    expect(heading).toBeDefined();
    expect(heading.color).toBe('DC2626');
    // ...and it does not borrow section 5's numbered badge.
    const badge = cont
      .flatMap((s) => texts(s))
      .find((t) => t.text === '5' && Math.abs(t.y - heading.y) < 0.05);
    expect(badge).toBeUndefined();
  });

  it('keeps Proposed Deal Structure on the first slide even with a tight column 1', () => {
    const slides = buildCompanyCardSlides(
      input({
        analysis: {
          business_overview: longMarkdown(20),
          investment_highlights: null,
          business_model_summary: null,
          diligence_priorities: null,
          investment_risks: null,
        },
        trackVariables: Array.from({ length: 14 }, (_, i) => ({
          name: `Variable ${i + 1}`,
          unit: '%',
          value: `${i}`,
        })),
      }),
    );
    expect(slideText(slides[0])).toContain('Proposed Deal Structure');
    expect(slideText(slides[0])).toContain('Indicative Financials');
    // The overview gave way instead, continuing on a later slide.
    expect(slides.length).toBeGreaterThan(1);
  });

  it('emits no HTML — colours are pptxgenjs hex without a leading #', () => {
    const [slide] = buildCompanyCardSlides(input());
    for (const el of slide.elements) {
      if (el.type === 'rect') expect(el.fill).toMatch(/^[0-9A-F]{6}$/);
      if (el.type === 'text') {
        expect(el.text).not.toContain('<');
        if (el.color) expect(el.color).toMatch(/^[0-9A-F]{6}$/);
      }
    }
  });
});

describe('buildCompanyCardDeck', () => {
  it('concatenates each company card in the order given', () => {
    const other = { ...company, target: 'Beta Mining', project_name: null };
    const slides = buildCompanyCardDeck([input(), input({ company: other })]);
    expect(slides[0].title).toContain('Acme Chemicals');
    expect(slides[slides.length - 1].title).toContain('Beta Mining');
  });

  it('returns [] for an empty input list', () => {
    expect(buildCompanyCardDeck([])).toEqual([]);
  });
});
