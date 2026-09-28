import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { evidenceLabelOf, isDataLimitBlock, type MarkdownTreeNode } from './evidenceLabels';

const text = (value: string): MarkdownTreeNode => ({ type: 'text', value });
const el = (tagName: string, ...children: MarkdownTreeNode[]): MarkdownTreeNode => ({
  type: 'element',
  tagName,
  children,
});

describe('isDataLimitBlock', () => {
  it('matches a paragraph that opens with a bold "Data limit:"', () => {
    expect(isDataLimitBlock(el('p', el('strong', text('Data limit:')), text(' No public dataset.')))).toBe(true);
  });

  it('matches a tight list item that opens with it, ignoring leading whitespace text', () => {
    expect(isDataLimitBlock(el('li', text('\n'), el('strong', text('Data limit:')), text(' x')))).toBe(true);
  });

  it('does not match when the lead is not first, not bold, or worded differently', () => {
    expect(isDataLimitBlock(el('p', text('See '), el('strong', text('Data limit:'))))).toBe(false);
    expect(isDataLimitBlock(el('p', text('Data limit: none')))).toBe(false);
    expect(isDataLimitBlock(el('p', el('strong', text('Data limits')), text(' apply')))).toBe(false);
    expect(isDataLimitBlock(el('p', el('em', text('Data limit:'))))).toBe(false);
    expect(isDataLimitBlock(el('h2', el('strong', text('Data limit:'))))).toBe(false);
    expect(isDataLimitBlock(undefined)).toBe(false);
  });
});

describe('evidenceLabelOf', () => {
  it('reads a bold run that is exactly one of the labels', () => {
    expect(evidenceLabelOf(el('strong', text('Observed')))).toBe('observed');
    expect(evidenceLabelOf(el('strong', text('Inferred')))).toBe('inferred');
    expect(evidenceLabelOf(el('strong', text('Modelled')))).toBe('modelled');
    expect(evidenceLabelOf(el('strong', text('Observed:')))).toBe('observed');
  });

  it('ignores other bold text and non-bold text', () => {
    expect(evidenceLabelOf(el('strong', text('Observed signals')))).toBeNull();
    expect(evidenceLabelOf(el('strong', text('observed')))).toBeNull();
    expect(evidenceLabelOf(el('strong', text('Modeled')))).toBeNull();
    expect(evidenceLabelOf(el('em', text('Observed')))).toBeNull();
    expect(evidenceLabelOf(text('Observed'))).toBeNull();
  });
});

describe('MarkdownRenderer evidence markers (real markdown tree)', () => {
  const render = (content: string, evidenceMarkers = true) =>
    renderToStaticMarkup(createElement(MarkdownRenderer, { content, evidenceMarkers }));

  it('renders the pinned forms as a callout and pills', () => {
    const html = render(
      [
        '**Data limit:** No public per-company approved-quota dataset exists.',
        '',
        '**Observed** Decree SK 123/2024 changed the badan penyelenggara.',
        '',
        '**Inferred** from: the decree and the PDDikti change.',
        '',
        'Phase 2 absorption: 40% **Modelled**',
      ].join('\n'),
    );
    expect(html).toContain('data-testid="chat-data-limit"');
    expect(html).toContain('data-testid="chat-evidence-observed"');
    expect(html).toContain('data-testid="chat-evidence-inferred"');
    expect(html).toContain('data-testid="chat-evidence-modelled"');
  });

  it.each([
    ['tight', '\n'],
    ['loose', '\n\n'],
  ])('renders a guardrail inside a %s bullet list as one callout', (_label, sep) => {
    const html = render(`- **Data limit:** Pembina names need a notarial extract.${sep}- Other point`);
    expect(html.match(/data-testid="chat-data-limit"/g)).toHaveLength(1);
  });

  it('leaves ordinary text untouched', () => {
    const html = render(
      'We Observed the decree last week. **Observed signals** were thin. See **Data limit** below, and a Data limit: none.',
    );
    expect(html).not.toContain('chat-data-limit');
    expect(html).not.toContain('chat-evidence-');
  });

  it('renders nothing special when the flag is off', () => {
    const html = render('**Data limit:** x\n\n**Observed** y', false);
    expect(html).not.toContain('chat-data-limit');
    expect(html).not.toContain('chat-evidence-');
  });
});
