/**
 * YouTube URL helpers. A YouTube link is the one kind of URL the app renders
 * as media rather than as a plain link — on the timeline, as a Featured Slide,
 * and in the Presentation viewer.
 */

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extracts the 11-character video id from any of the common YouTube URL shapes
 * (`watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, `/live/`, `/v/`). Returns
 * null for anything that is not a single YouTube video — including channel and
 * playlist-only URLs, which have nothing to embed as one player.
 */
export function parseYouTubeVideoId(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;

  if (host === 'youtu.be' || host === 'www.youtu.be') {
    candidate = url.pathname.split('/')[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    const [, first, second] = url.pathname.split('/');
    if (first === 'watch') {
      candidate = url.searchParams.get('v');
    } else if (first === 'embed' || first === 'shorts' || first === 'live' || first === 'v') {
      candidate = second ?? null;
    }
  }

  return candidate && VIDEO_ID.test(candidate) ? candidate : null;
}

export function isYouTubeVideoUrl(url: string | null | undefined): boolean {
  return parseYouTubeVideoId(url) !== null;
}

/**
 * Parses a `t` / `start` offset (`90`, `90s`, `1m30s`, `1h2m3s`) into whole
 * seconds, so a link shared at a timestamp starts the embed there too.
 */
function parseStartSeconds(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || !match[0]) return null;
  const [, h, m, s] = match;
  return Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
}

/** The privacy-enhanced embed URL for a YouTube link, or null when it is not one. */
export function youTubeEmbedUrl(rawUrl: string | null | undefined): string | null {
  const id = parseYouTubeVideoId(rawUrl);
  if (!id || !rawUrl) return null;
  const source = new URL(rawUrl.trim());
  const start = parseStartSeconds(source.searchParams.get('t') ?? source.searchParams.get('start'));
  const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
  embed.searchParams.set('rel', '0');
  if (start) embed.searchParams.set('start', String(start));
  return embed.toString();
}
