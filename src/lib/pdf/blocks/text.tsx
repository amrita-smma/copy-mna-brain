/**
 * Typography blocks. These were already the least broken part of the previous
 * renderer — `drawWrapped` did wrap — but they are reimplemented here so the
 * whole document goes through one layout engine.
 */
import { View, Text } from '@react-pdf/renderer';
import { COLOR, FONT, LINE, styles, typeStyle } from '../theme';

export function Paragraph({ text }: { text: string }) {
  return <Text style={styles.paragraph}>{text}</Text>;
}

export function Bullets({ items }: { items: string[] }) {
  if (items.length === 0) {
    return <Text style={[styles.paragraph, styles.muted]}>(none)</Text>;
  }
  return (
    <View style={{ marginBottom: 6 }}>
      {items.map((item, i) => (
        <View key={`${item}-${i}`} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

export function References({
  references,
}: {
  references: Array<{ name: string; link?: string | null; date?: string | null }>;
}) {
  return (
    <View>
      {references.map((ref, i) => {
        const date = ref.date ? ` (${ref.date})` : '';
        return (
          <View key={`${ref.name}-${i}`} style={styles.bulletRow}>
            <Text style={{ width: 16, color: COLOR.textMuted, flexShrink: 0 }}>{`${i + 1}.`}</Text>
            <Text style={{ flex: 1, ...typeStyle(FONT.body, LINE.tight) }}>
              {`${ref.name}${date}`}
              {ref.link ? (
                // Long URLs are the one case where breaking inside a "word" is
                // correct; without this the layout engine would push the whole
                // url past the margin rather than splitting it.
                <Text style={{ color: COLOR.pillInfoFg }}>{` ${ref.link}`}</Text>
              ) : null}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
