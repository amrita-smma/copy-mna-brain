import { describe, expect, it } from 'vitest';
import { isYouTubeVideoUrl, parseYouTubeVideoId, youTubeEmbedUrl } from './youtube';

describe('parseYouTubeVideoId', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=2'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?t=42'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ'],
    ['https://www.youtube.com/live/dQw4w9WgXcQ?feature=share'],
    ['  https://www.youtube.com/watch?v=dQw4w9WgXcQ  '],
  ])('extracts the video id from %s', (url) => {
    expect(parseYouTubeVideoId(url)).toBe('dQw4w9WgXcQ');
  });

  it.each([
    [null],
    [''],
    ['not a url'],
    ['https://example.com/watch?v=dQw4w9WgXcQ'],
    ['https://www.youtube.com/@somechannel'],
    ['https://www.youtube.com/playlist?list=PL123'],
    ['https://www.youtube.com/watch?v=short'],
    ['javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'],
  ])('returns null for %s', (url) => {
    expect(parseYouTubeVideoId(url)).toBeNull();
  });
});

describe('isYouTubeVideoUrl', () => {
  it('is true only for a single-video YouTube URL', () => {
    expect(isYouTubeVideoUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(isYouTubeVideoUrl('https://vimeo.com/12345')).toBe(false);
  });
});

describe('youTubeEmbedUrl', () => {
  it('builds a privacy-enhanced embed URL', () => {
    expect(youTubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0',
    );
  });

  it.each([
    ['https://youtu.be/dQw4w9WgXcQ?t=42', '42'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s', '90'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h0m5s', '3605'],
  ])('carries the start offset of %s', (url, start) => {
    expect(new URL(youTubeEmbedUrl(url)!).searchParams.get('start')).toBe(start);
  });

  it('returns null for a non-YouTube URL', () => {
    expect(youTubeEmbedUrl('https://example.com/video.mp4')).toBeNull();
  });
});
