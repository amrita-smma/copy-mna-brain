/**
 * KPI cards — a wrapping row of bordered tiles.
 *
 * The previous renderer drew three fixed-width cards per row and truncated the
 * value and hint to `lines[0]`, so "Grab ~10x · Sea ~13x · Meituan ~19x" was
 * silently delivered as "Grab ~10x · Sea ~13x · Meituan". Here both are plain
 * `<Text>` that wrap, and the card grows to fit them.
 */
import { View, Text } from '@react-pdf/renderer';
import { COLOR, CONTENT_WIDTH, FONT, LINE, typeStyle } from '../theme';
import type { ImageCache } from '../assets';
import type { KpiInput } from '../types';
import { Logo } from './primitives';

const GAP = 8;
const PER_ROW = 3;
const CARD_WIDTH = (CONTENT_WIDTH - GAP * (PER_ROW - 1)) / PER_ROW;

export function KpiCards({ cards, images }: { cards: KpiInput[]; images: ImageCache }) {
  if (cards.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: GAP, marginBottom: 8 }}>
      {cards.map((card, i) => (
        <View
          key={`${card.label}-${i}`}
          // A card never splits across a page: it is short, and half a tile
          // reads as a rendering fault.
          wrap={false}
          style={{
            width: CARD_WIDTH,
            backgroundColor: COLOR.cardBg,
            borderWidth: 0.8,
            borderColor: COLOR.border,
            borderRadius: 3,
            paddingVertical: 7,
            paddingHorizontal: 8,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
            <Logo url={card.logoUrl} images={images} size={9} />
            <Text
              style={{
                ...typeStyle(FONT.tiny, LINE.tight),
                fontWeight: 600,
                color: COLOR.textMuted,
                flex: 1,
              }}
            >
              {card.label.toUpperCase()}
            </Text>
          </View>
          <Text style={{ ...typeStyle(13, LINE.tight), fontWeight: 700 }}>
            {card.value}
          </Text>
          {card.hint ? (
            <Text
              style={{
                ...typeStyle(FONT.tiny, LINE.tight),
                color: COLOR.textMuted,
                marginTop: 3,
              }}
            >
              {card.hint}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
