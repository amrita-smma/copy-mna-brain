import { describe, expect, it } from 'vitest';
import { UnsupportedFeaturedSlideError, assertFeaturableFile, assertFeaturableLink } from './featuredSlide';

describe('assertFeaturableFile', () => {
  it.each([['deck.pdf'], ['deck.pptx'], ['pitch.mp4'], ['screen-recording.mov'], ['call.mp3'], ['memo.m4a']])(
    'accepts %s',
    (fileName) => {
      expect(() => assertFeaturableFile(fileName)).not.toThrow();
    },
  );

  it.each([['notes.docx'], ['logo.png'], ['model.xlsx'], ['README']])('rejects %s', (fileName) => {
    expect(() => assertFeaturableFile(fileName)).toThrow(UnsupportedFeaturedSlideError);
  });
});

describe('assertFeaturableLink', () => {
  it('accepts a YouTube video link', () => {
    expect(() => assertFeaturableLink('https://youtu.be/dQw4w9WgXcQ')).not.toThrow();
  });

  it.each([['https://example.com/deck'], ['https://www.youtube.com/@channel'], ['not a url']])(
    'rejects %s',
    (url) => {
      expect(() => assertFeaturableLink(url)).toThrow(UnsupportedFeaturedSlideError);
    },
  );
});
