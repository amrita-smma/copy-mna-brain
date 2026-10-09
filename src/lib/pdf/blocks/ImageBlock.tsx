/**
 * A standalone image with an optional caption.
 *
 * The bytes come from the up-front fetch pass in `assets.ts`; a URL that failed
 * renders nothing at all, so a dead logo host costs a figure rather than the
 * whole email.
 */
import { View, Text, Image } from '@react-pdf/renderer';
import { COLOR, FONT, LINE, typeStyle } from '../theme';
import type { ImageCache } from '../assets';

export function ImageBlock({
  url,
  caption,
  maxHeight = 180,
  images,
}: {
  url: string;
  caption?: string;
  maxHeight?: number;
  images: ImageCache;
}) {
  const bytes = images.get(url);
  if (!bytes) return null;
  return (
    <View style={{ marginBottom: 8, alignItems: 'center' }} wrap={false}>
      <Image
        src={bytes}
        style={{ maxHeight, maxWidth: '100%', objectFit: 'contain' }}
      />
      {caption ? (
        <Text
          style={{
            ...typeStyle(FONT.tiny, LINE.tight),
            color: COLOR.textMuted,
            marginTop: 4,
            textAlign: 'center',
          }}
        >
          {caption}
        </Text>
      ) : null}
    </View>
  );
}
