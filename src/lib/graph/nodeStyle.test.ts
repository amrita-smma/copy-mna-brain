import { describe, expect, it } from 'vitest';
import type { GraphNode } from '@/lib/repositories/companyRelationRepository';
import {
  STAGE_COLOR_BLUE,
  STAGE_COLOR_GREY,
  STAGE_COLOR_YELLOW,
  UNKNOWN_RELATION_COLOR,
  drawGraphNode,
  endpointId,
  estimateNodeRadius,
  evToDisplaySize,
  getNodeRadius,
  hexToRgbTriplet,
  nodeColor,
  nodeDisplaySize,
  nodeSizeFactor,
  primaryRelationByNode,
  relationColor,
  relationLabel,
  toUpperLabelLines,
} from './nodeStyle';

function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return { id: 'c1', name: 'TechCorp', val: 3, ...overrides };
}

describe('nodeColor', () => {
  it('paints L0–L5 blue', () => {
    for (const stage of ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']) {
      expect(nodeColor(node({ pipelineStage: stage }))).toBe(STAGE_COLOR_BLUE);
    }
  });

  it('paints market screening, unreviewed and missing stages yellow', () => {
    expect(nodeColor(node({ pipelineStage: 'market_screening' }))).toBe(STAGE_COLOR_YELLOW);
    expect(nodeColor(node({ pipelineStage: 'unreviewed' }))).toBe(STAGE_COLOR_YELLOW);
    expect(nodeColor(node({ pipelineStage: undefined }))).toBe(STAGE_COLOR_YELLOW);
  });

  it('paints discovered and unrecognised stages grey', () => {
    expect(nodeColor(node({ pipelineStage: 'discovered' }))).toBe(STAGE_COLOR_GREY);
    expect(nodeColor(node({ pipelineStage: 'L6' }))).toBe(STAGE_COLOR_GREY);
  });
});

describe('evToDisplaySize', () => {
  it('clamps at 1 up to $1B and at 5 from $100B', () => {
    expect(evToDisplaySize(0)).toBe(1);
    expect(evToDisplaySize(1000)).toBe(1);
    expect(evToDisplaySize(100000)).toBe(5);
    expect(evToDisplaySize(500000)).toBe(5);
  });

  it('log-interpolates between the two bounds', () => {
    // log10(10000) = 4 → halfway across the 2-decade range → size 3
    expect(evToDisplaySize(10000)).toBeCloseTo(3, 10);
  });
});

describe('nodeDisplaySize', () => {
  it('prefers an explicit override over EV', () => {
    expect(nodeDisplaySize(node({ graphSizeOverride: 2, ev: 100000 }))).toBe(2);
  });

  it('derives from EV when there is no override', () => {
    expect(nodeDisplaySize(node({ ev: 100000 }))).toBe(5);
  });

  it('falls back to 3 when neither is recorded', () => {
    expect(nodeDisplaySize(node({ ev: null, graphSizeOverride: null }))).toBe(3);
  });
});

describe('nodeSizeFactor', () => {
  it('scales 1.3× per display-size step from a 1× baseline', () => {
    expect(nodeSizeFactor(node({ graphSizeOverride: 1 }))).toBeCloseTo(1, 10);
    expect(nodeSizeFactor(node({ graphSizeOverride: 2 }))).toBeCloseTo(1.3, 10);
    expect(nodeSizeFactor(node({ graphSizeOverride: 5 }))).toBeCloseTo(1.3 ** 4, 10);
  });
});

describe('getNodeRadius / estimateNodeRadius', () => {
  it('agree at globalScale 1', () => {
    const factor = nodeSizeFactor(node({ graphSizeOverride: 4 }));
    expect(getNodeRadius(1, factor)).toBe(estimateNodeRadius(factor));
  });

  it('shrinks the canvas radius as the view zooms in', () => {
    expect(getNodeRadius(2, 1)).toBe(getNodeRadius(1, 1) / 2);
  });

  it('applies the display scale, and still agrees between the two at globalScale 1', () => {
    expect(getNodeRadius(1, 1, 0.5)).toBe(getNodeRadius(1, 1) / 2);
    expect(getNodeRadius(1, 1, 0.55)).toBe(estimateNodeRadius(1, 0.55));
  });

  it('defaults the scale to 1 so existing call sites are unchanged', () => {
    expect(getNodeRadius(1.5, 2)).toBe(getNodeRadius(1.5, 2, 1));
    expect(estimateNodeRadius(2)).toBe(estimateNodeRadius(2, 1));
  });
});

describe('toUpperLabelLines', () => {
  it('upper-cases and keeps a short name on one line', () => {
    expect(toUpperLabelLines('TechCorp')).toEqual(['TECHCORP']);
  });

  it('wraps on word boundaries at 12 characters', () => {
    expect(toUpperLabelLines('Acme Global Holdings')).toEqual(['ACME GLOBAL', 'HOLDINGS']);
  });

  it('truncates to three lines with an ellipsis', () => {
    const lines = toUpperLabelLines('Alpha Bravo Charlie Delta Echo Foxtrot Golf');
    expect(lines).toHaveLength(3);
    expect(lines[2].endsWith('...')).toBe(true);
  });

  it('falls back to UNKNOWN for a blank name', () => {
    expect(toUpperLabelLines('   ')).toEqual(['UNKNOWN']);
  });
});

describe('hexToRgbTriplet', () => {
  it('converts a #rrggbb string to an rgba-ready triplet', () => {
    expect(hexToRgbTriplet('#3b82f6')).toBe('59, 130, 246');
    expect(hexToRgbTriplet('ffffff')).toBe('255, 255, 255');
  });
});

describe('endpointId', () => {
  it('reads the id off a node object and passes strings through', () => {
    expect(endpointId('c1')).toBe('c1');
    expect(endpointId(node({ id: 'c2' }))).toBe('c2');
  });
});

describe('relationColor / relationLabel', () => {
  it('resolves known relation types', () => {
    expect(relationColor('PARTNER')).toBe('#22c55e');
    expect(relationLabel('INVESTED_IN')).toBe('Invested in');
  });

  it('falls back for unknown types', () => {
    expect(relationColor('MYSTERY')).toBe(UNKNOWN_RELATION_COLOR);
    expect(relationLabel('MYSTERY')).toBe('MYSTERY');
  });
});

/**
 * Minimal 2D-context stand-in that records the geometry drawGraphNode paints.
 * `measureText` approximates 6px per character so the fitting maths is exercised.
 */
function makeCtx() {
  const arcs: Array<{ r: number }> = [];
  const fonts: string[] = [];
  const texts: string[] = [];
  const ctx = {
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    arc: (_x: number, _y: number, r: number) => arcs.push({ r }),
    fill: () => {},
    stroke: () => {},
    measureText: (t: string) => ({ width: t.length * 6 }),
    fillText: (t: string) => texts.push(t),
    set font(v: string) {
      fonts.push(v);
    },
    get font() {
      return fonts[fonts.length - 1] ?? '';
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
    textAlign: '',
    textBaseline: '',
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, arcs, fonts, texts };
}

/** First font size (px) recorded on the context. */
function firstFontPx(fonts: string[]): number {
  return Number(fonts[0].match(/(\d+(?:\.\d+)?)px/)![1]);
}

describe('drawGraphNode', () => {
  it('scales the circle and the label metrics together', () => {
    const full = makeCtx();
    const small = makeCtx();

    drawGraphNode(node({ name: 'TechCorp' }), full.ctx, 1);
    drawGraphNode(node({ name: 'TechCorp' }), small.ctx, 1, { scale: 0.5 });

    expect(small.arcs[0].r).toBeCloseTo(full.arcs[0].r / 2, 10);
    expect(firstFontPx(small.fonts)).toBeCloseTo(firstFontPx(full.fonts) / 2, 10);
    // The label still fits rather than being truncated away by the smaller box.
    expect(small.texts).toContain('TECHCORP');
  });

  it('draws an unscaled node identically to scale 1', () => {
    const implicit = makeCtx();
    const explicit = makeCtx();

    drawGraphNode(node(), implicit.ctx, 1);
    drawGraphNode(node(), explicit.ctx, 1, { scale: 1 });

    expect(implicit.arcs).toEqual(explicit.arcs);
    expect(implicit.fonts).toEqual(explicit.fonts);
    expect(implicit.texts).toEqual(explicit.texts);
  });

  it('renders the relationship sub-label when one is given', () => {
    const { ctx, texts } = makeCtx();

    drawGraphNode(node(), ctx, 1, { subLabel: 'Partner' });

    expect(texts).toContain('Partner');
  });
});

describe('primaryRelationByNode', () => {
  it('picks each node’s most frequent incident relation type', () => {
    const primary = primaryRelationByNode([
      { source: 'c1', target: 'c2', label: 'PARTNER' },
      { source: 'c1', target: 'c3', label: 'PARTNER' },
      { source: 'c1', target: 'c4', label: 'SELLS_TO' },
    ]);

    expect(primary.get('c1')).toBe('PARTNER');
    expect(primary.get('c4')).toBe('SELLS_TO');
  });

  it('breaks ties on the canonical relation order', () => {
    const primary = primaryRelationByNode([
      { source: 'c1', target: 'c2', label: 'PARTNER' },
      { source: 'c1', target: 'c3', label: 'INVESTED_IN' },
    ]);

    expect(primary.get('c1')).toBe('INVESTED_IN');
  });

  it('ignores unknown relation types and nodes without any', () => {
    const primary = primaryRelationByNode([{ source: 'c1', target: 'c2', label: 'MYSTERY' }]);

    expect(primary.size).toBe(0);
  });

  it('resolves endpoints that force-graph has replaced with node objects', () => {
    const primary = primaryRelationByNode([
      { source: node({ id: 'c1' }), target: node({ id: 'c2' }), label: 'PARTNER' },
    ]);

    expect(primary.get('c1')).toBe('PARTNER');
    expect(primary.get('c2')).toBe('PARTNER');
  });
});
