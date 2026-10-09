/**
 * Priority rows: a colour-filled tag, a bolded action, and an optional muted
 * meta line. The meta line is a sibling `<Text>` inside the row's own column
 * rather than something drawn at a computed y, so it cannot land on the row
 * below it.
 */
import { View, Text } from '@react-pdf/renderer';
import { COLOR, FONT, LINE, typeStyle } from '../theme';
import type { PriorityItemInput } from '../types';
import { SolidPill } from './primitives';

export function PriorityList({ items }: { items: PriorityItemInput[] }) {
  if (items.length === 0) return null;
  return (
    <View style={{ marginBottom: 8 }}>
      {items.map((item, i) => (
        <View
          key={`${item.description}-${i}`}
          wrap={false}
          style={{ flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 }}
        >
          <View style={{ flexShrink: 0, marginRight: 8, paddingTop: 0.5 }}>
            <SolidPill label={item.priority.label} tone={item.priority.tone} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: 600, ...typeStyle(FONT.body, LINE.tight) }}>{item.description}</Text>
            {item.meta ? (
              <Text
                style={{
                  ...typeStyle(FONT.small, LINE.tight),
                  color: COLOR.textMuted,
                  marginTop: 2,
                }}
              >
                {item.meta}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}
