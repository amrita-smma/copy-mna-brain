/**
 * Small pieces shared across blocks: pills, logos and the section headings.
 *
 * Everything here is sized by its content through flexbox. The previous
 * renderer sized a pill as `textWidth + 12` and then drew it into a fixed 80pt
 * column, which is how a long verdict ended up printed on top of the next
 * column.
 */
import { View, Text, Image } from '@react-pdf/renderer';
import { COLOR, FONT, styles, typeStyle } from '../theme';
import type { ImageCache } from '../assets';
import type { HeadingLevel, PillInput, PillTone, PriorityTone } from '../types';

export function pillPalette(tone: PillTone): { fg: string; bg: string } {
  switch (tone) {
    case 'positive':
      return { fg: COLOR.pillPositiveFg, bg: COLOR.pillPositiveBg };
    case 'negative':
      return { fg: COLOR.pillNegativeFg, bg: COLOR.pillNegativeBg };
    case 'warning':
      return { fg: COLOR.pillWarningFg, bg: COLOR.pillWarningBg };
    case 'info':
      return { fg: COLOR.pillInfoFg, bg: COLOR.pillInfoBg };
    case 'neutral':
    default:
      return { fg: COLOR.pillNeutralFg, bg: COLOR.pillNeutralBg };
  }
}

export function priorityFill(tone: PriorityTone): string {
  if (tone === 'high') return COLOR.priorityHigh;
  if (tone === 'medium') return COLOR.priorityMedium;
  return COLOR.priorityLow;
}

/**
 * `alignSelf: 'flex-start'` is what stops the pill stretching to its column;
 * `flexShrink` lets a long label wrap inside the pill instead of spilling past
 * it.
 */
export function Pill({ pill }: { pill: PillInput }) {
  const palette = pillPalette(pill.tone);
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexShrink: 1,
        backgroundColor: palette.bg,
        borderWidth: 0.6,
        borderColor: palette.fg,
        borderRadius: 7,
        paddingHorizontal: 5,
        paddingVertical: 1.5,
      }}
    >
      <Text style={{ ...typeStyle(FONT.tiny, 1.25), fontWeight: 600, color: palette.fg }}>
        {pill.label}
      </Text>
    </View>
  );
}

/** Filled pill with white text, used by `priority_list`. */
export function SolidPill({ label, tone }: { label: string; tone: PriorityTone }) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        backgroundColor: priorityFill(tone),
        borderRadius: 7,
        paddingHorizontal: 6,
        paddingVertical: 2,
      }}
    >
      <Text style={{ ...typeStyle(FONT.tiny, 1.25), fontWeight: 700, color: COLOR.white }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Renders a fetched logo, or nothing.
 *
 * A URL that failed to load is present in the cache with an `undefined` value,
 * so a missing logo is a layout no-op rather than a broken-image box.
 */
export function Logo({
  url,
  images,
  size = 10,
}: {
  url?: string | null;
  images: ImageCache;
  size?: number;
}) {
  if (!url) return null;
  const bytes = images.get(url);
  if (!bytes) return null;
  return (
    <Image
      src={bytes}
      style={{ width: size, height: size, objectFit: 'contain', marginRight: 4, flexShrink: 0 }}
    />
  );
}

export function SectionHeading({ text, level }: { text: string; level: HeadingLevel }) {
  if (level === 'subsection') {
    return <Text style={styles.subsectionHeadingText}>{text}</Text>;
  }
  return (
    // `minPresenceAhead` stops a heading printing as the last thing on a page
    // with its content orphaned onto the next one. 90pt is roughly the
    // shortest block worth following a heading with — a few lines of prose, or
    // the top of a table.
    <View style={styles.sectionHeading} wrap={false} minPresenceAhead={90}>
      <View style={styles.sectionAccentBar} />
      <Text style={styles.sectionHeadingText}>{text}</Text>
    </View>
  );
}
