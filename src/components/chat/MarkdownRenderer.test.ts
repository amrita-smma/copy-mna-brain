import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownRenderer } from './MarkdownRenderer';

const render = (content: string, citationPills = true) =>
  renderToStaticMarkup(createElement(MarkdownRenderer, { content, citationPills }));

const chips = (html: string) => html.match(/data-testid="chat-citation-group"/g)?.length ?? 0;

describe('MarkdownRenderer citation chips', () => {
  it('draws a citation as one chip with its source, and drops the parentheses around it', () => {
    const html = render('Nickel output rose 9% ([Reuters, 12 Mar 2026](https://www.reuters.com/a "Nickel output jumps")).');

    expect(chips(html)).toBe(1);
    expect(html).toContain('aria-label="Sources: Reuters"');
    expect(html).toContain('>Reuters</span>');
    expect(html).toContain('Nickel output rose 9%<button');
    expect(html).toContain('</button>.</p>');
    expect(html).not.toContain('href="https://www.reuters.com/a"');
  });

  it('groups adjacent citations into one chip that counts the rest', () => {
    for (const md of [
      'Point ([Motley Fool, 14 Oct 2026](https://a.example)) ([Yahoo Finance, 9 Oct 2026](https://b.example)).',
      'Point ([Motley Fool, 14 Oct 2026](https://a.example); [Yahoo Finance, 9 Oct 2026](https://b.example)).',
      'Point [Motley Fool, 14 Oct 2026](https://a.example), [Yahoo Finance, 9 Oct 2026](https://b.example).',
    ]) {
      const html = render(md);
      expect(chips(html)).toBe(1);
      expect(html).toContain('aria-label="Sources: Motley Fool, Yahoo Finance"');
      expect(html).toContain('+1</span>');
      expect(html).toContain('Point<button');
      expect(html).toContain('</button>.</p>');
    }
  });

  it('counts a source cited twice in one run once', () => {
    const html = render('Point ([A Wire, 1 Oct 2026](https://a.example); [A Wire, 1 Oct 2026](https://a.example)).');
    expect(html).toContain('aria-label="Sources: A Wire"');
    expect(html).not.toContain('+1');
  });

  it('keeps citations apart when prose stands between them, and leaves the prose intact', () => {
    const html = render(
      'Revenue grew ([Reuters, 12 Mar 2026](https://a.example)) while margins fell ([Bloomberg, Mar 2026](https://b.example)).',
    );
    expect(chips(html)).toBe(2);
    expect(html).toContain('</button> while margins fell<button');
  });

  it('groups citations inside list items too', () => {
    const html = render('- First ([Reuters, 12 Mar 2026](https://a.example))\n- Second ([Bloomberg, undated](https://b.example))');
    expect(chips(html)).toBe(2);
    expect(html).toContain('data-citation="undated"');
  });

  it('flags a group holding a source older than the staleness threshold', () => {
    const html = render('Old news ([Reuters, 12 Mar 2019](https://a.example)).');
    expect(html).toContain('data-citation="stale"');
  });

  it('leaves ordinary links, non-citations and half-streamed citations as they were', () => {
    const html = render(
      'See [the filing](https://sec.example) and [Smith, 2024](https://s.example) (an aside). Then [Reuters, 12 Mar',
    );
    expect(chips(html)).toBe(0);
    expect(html).toContain('href="https://sec.example"');
    expect(html).toContain('>Smith, 2024</a> (an aside)');
    expect(html).toContain('[Reuters, 12 Mar');
  });

  it('keeps a parenthesis that belongs to the prose', () => {
    const html = render('(Per [Reuters, 12 Mar 2026](https://a.example) and others.)');
    expect(chips(html)).toBe(1);
    expect(html).toContain('>(Per<button');
    expect(html).toContain('</button> and others.)</p>');
  });

  it('renders citation links as plain links when chips are off', () => {
    const html = render('Point ([Reuters, 12 Mar 2026](https://a.example)).', false);
    expect(chips(html)).toBe(0);
    expect(html).toContain('href="https://a.example"');
    expect(html).toContain('(<a');
  });

  it('rebuilds an HTML anchor the model wrote as a real link instead of printing the tags', () => {
    const html = render(
      'It <a href="https://news.example/bibica">distributes to **100,000** outlets</a> ([Tuoi Tre, Nov 2025](https://news.example/bibica)).',
    );
    expect(html).not.toContain('&lt;a href');
    expect(html).not.toContain('&lt;/a&gt;');
    expect(html).toContain('<a href="https://news.example/bibica"');
    expect(html).toContain('distributes to <strong');
    expect(chips(html)).toBe(1);
  });

  it('reduces an unsafe HTML anchor to its text and leaves an unclosed one unlinked', () => {
    const html = render('A <a href="javascript:alert(1)">bad</a> and <a href="https://x.example">open');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('A bad and');
    expect(html).not.toContain('href="https://x.example"');
  });

  it('reads a citation whose date sits at the end of a phrase', () => {
    const html = render('Sales flat ([EMIS, profile updated May 2026](https://emis.example)).');
    expect(chips(html)).toBe(1);
    expect(html).toContain('aria-label="Sources: EMIS"');
  });

  it('splits a claim wrapped into its citation link into the claim and a chip', () => {
    const html = render('Named to the [VNR Top 10 food list (Dan Tri, 24 Oct 2026)](https://dantri.example).');
    expect(chips(html)).toBe(1);
    expect(html).toContain('Named to the VNR Top 10 food list<button');
    expect(html).toContain('aria-label="Sources: Dan Tri"');
  });

  it('paints the chip on opaque surfaces', () => {
    const html = render('Point ([Reuters, 12 Mar 2026](https://a.example)).');
    expect(html).not.toMatch(/bg-(card|muted|background|popover)\/\d+/);
  });
});
