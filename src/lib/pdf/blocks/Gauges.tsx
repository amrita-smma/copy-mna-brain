/**
 * Horizontal percentage bars.
 *
 * The three parts are flex children of one row, so the label can never reach
 * under the bar and the value can never leave the page — the two failure modes
 * of the previous absolute-coordinate version, which put the label at a fixed
 * x and the value 72pt from the right margin.
 */
import { View, Text } from '@react-pdf/renderer';
import { COLOR, FONT, LINE, typeStyle } from '../theme';
import { formatPercent } from '../format';
import type { GaugeInput, GaugeTone } from '../types';

function fillColor(tone: GaugeTone | undefined): string {
  if (tone === 'positive') return COLOR.pillPositiveFg;
  if (tone === 'negative') return COLOR.pillNegativeFg;
  return COLOR.pillNeutralFg;
}

export function Gauges({ gauges }: { gauges: GaugeInput[] }) {
  if (gauges.length === 0) return null;
  return (
    <View style={{ marginBottom: 8 }}>
      {gauges.map((gauge, i) => {
        const pct = Math.max(0, Math.min(Number.isFinite(gauge.valuePct) ? gauge.valuePct : 0, 100));
        const color = fillColor(gauge.tone);
        const value = gauge.trendLabel
          ? `${formatPercent(gauge.valuePct)} (${gauge.trendLabel})`
          : formatPercent(gauge.valuePct);
        return (
          <View
            key={`${gauge.label}-${i}`}
            wrap={false}
            style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 5 }}
          >
            <Text style={{ width: '32%', paddingRight: 8, ...typeStyle(FONT.body, LINE.tight) }}>
              {gauge.label}
            </Text>
            <View
              style={{
                flex: 1,
                height: 7,
                backgroundColor: COLOR.cardBg,
                borderWidth: 0.5,
                borderColor: COLOR.border,
                borderRadius: 3.5,
              }}
            >
              <View
                style={{
                  width: `${pct}%`,
                  height: '100%',
                  backgroundColor: color,
                  borderRadius: 3.5,
                }}
              />
            </View>
            <Text
              style={{
                width: '26%',
                paddingLeft: 7,
                ...typeStyle(FONT.small, LINE.tight),
                fontWeight: 600,
                color,
              }}
            >
              {value}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
