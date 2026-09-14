import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PricePerUnitField } from './PricePerUnitField';

const render = (overrides: Partial<Parameters<typeof PricePerUnitField>[0]> = {}) =>
  renderToStaticMarkup(createElement(PricePerUnitField, {
    id: 'price', value: '', units: '-3', cash: '100', currency: 'USD',
    onChange: () => {}, ...overrides,
  }));

describe('PricePerUnitField', () => {
  it('shows the unsigned implied price for redemptions and updates with cash', () => {
    expect(render()).toContain('USD 33.33333333');
    expect(render({ cash: '120' })).toContain('USD 40.00000000');
  });

  it('keeps all eight decimal places without converting through a floating point number', () => {
    expect(render({ units: '1', cash: '9007199254740993.12345678' }))
      .toContain('9007199254740993.12345678');
  });

  it('keeps explicit overrides editable without changing their value', () => {
    const html = render({ value: '31.25' });
    expect(html).toContain('value="31.25"');
    expect(html).toContain('entering a price does not change cash');
    expect(html).not.toContain('calculated from cash');
  });

  it.each([{ units: '0' }, { cash: '0' }, { units: '-' }])(
    'leaves price optional when no calculation is possible: %j',
    (input) => {
      expect(render(input)).toContain('placeholder="Optional"');
      expect(render(input)).not.toContain('calculated from cash');
    },
  );
});
