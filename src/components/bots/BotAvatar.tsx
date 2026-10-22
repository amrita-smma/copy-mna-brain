"use client";

/**
 * A bot's animated avatar (RFC 02 §4): a soft, glossy character with a dark
 * visor and glowing eyes, in one of five bodies — Nova (a sphere), Hexa (a
 * ring of hexagons), Nimbo (a cloud), Orbit (a ringed planet) and Pixel (a
 * pyramid with a lit capstone). The body is a gradient of the bot's hue with a specular
 * highlight; the eyes carry the expression. Brain Bot alone wears Apex: a
 * glossy black sphere with a bezelled black visor, lit amber at the edge,
 * with white eyes. framer-motion only.
 *
 * `state` comes from `deriveAvatarState` (`@/lib/bots/avatarState`). The look
 * (hue, eyes, mood, shape) comes from `bots.avatar`. With
 * `prefers-reduced-motion` the body holds still and only the eyes change.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { motion, useMotionValue, useReducedMotion, useSpring, type Transition } from 'framer-motion';
import type { AvatarState } from '@/lib/bots/avatarState';
import { resolveBotAvatar, type BotAvatarConfig, type BotBody, type BotEyeStyle } from '@/lib/bots/types';
import { cn } from '@/lib/utils';

const SIZES = { xs: 20, sm: 32, md: 48, xl: 96, lg: 112 } as const;
export type BotAvatarSize = keyof typeof SIZES;

interface BotAvatarProps {
  avatar?: BotAvatarConfig | null;
  state?: AvatarState;
  size?: BotAvatarSize;
  className?: string;
  /** Accessible label; defaults to decorative. */
  label?: string;
  /** Follow the pointer. Off for strip tiles that are not the active bot. */
  trackCursor?: boolean;
}

/** Where a body's visor sits, and the eyes' centre and scale on it. */
interface Face {
  cx: number;
  cy: number;
  /** Eye scale: Hexa's visor is smaller than the others. */
  k: number;
}

const FACES: Record<BotBody, Face> = {
  apex: { cx: 52, cy: 52, k: 1.15 },
  nova: { cx: 57, cy: 52, k: 1 },
  hexa: { cx: 50, cy: 50, k: 0.78 },
  nimbo: { cx: 50, cy: 56, k: 0.9 },
  orbit: { cx: 52, cy: 48, k: 1 },
  pixel: { cx: 51, cy: 66, k: 0.88 },
};

/** The expression the eyes show. */
type Expression =
  | 'neutral'
  | 'sleepy'
  | 'happy'
  | 'thinking'
  | 'surprised'
  | 'excited'
  | 'wink'
  | 'wide';

function expressionFor(state: AvatarState, eyes: BotEyeStyle): Expression {
  switch (state) {
    case 'happy':
      return 'happy';
    case 'thinking':
      return 'thinking';
    case 'error':
      return 'excited';
    case 'waiting':
      return 'surprised';
    case 'handoff':
      return 'wink';
    case 'listening':
      return 'wide';
    default:
      return eyes === 'sleepy' ? 'sleepy' : 'neutral';
  }
}

/** Random 3–6s blink cadence; off when reduced motion is on. */
function useBlink(enabled: boolean): boolean {
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let reopen: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setClosed(true);
        reopen = setTimeout(() => {
          setClosed(false);
          schedule();
        }, 130);
      }, 3000 + Math.random() * 3000);
    };
    schedule();
    return () => {
      clearTimeout(timer);
      clearTimeout(reopen);
    };
  }, [enabled]);
  return closed;
}

/** A regular hexagon (pointy top) as a path. */
function hexPath(cx: number, cy: number, r: number): string {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = ((60 * i - 90) * Math.PI) / 180;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  });
  return `M${pts.join(' L')} Z`;
}

/** An arc of a circle, angles in degrees (0 = right, clockwise). */
function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const p = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
  };
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M${p(from)} A${r},${r} 0 ${large} 1 ${p(to)}`;
}

const HEXA_PETALS = Array.from({ length: 6 }, (_, i) => {
  const a = ((60 * i - 90) * Math.PI) / 180;
  return { cx: 50 + 30 * Math.cos(a), cy: 50 + 30 * Math.sin(a) };
});

/** A closed polygon whose corners are rounded with radius `r`. */
function roundedPolygon(points: readonly (readonly [number, number])[], r: number): string {
  const n = points.length;
  const toward = (a: readonly number[], b: readonly number[]) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const k = Math.min(r, len / 2) / len;
    return `${(a[0] + dx * k).toFixed(2)},${(a[1] + dy * k).toFixed(2)}`;
  };
  return (
    points
      .map((p, i) => {
        const prev = points[(i + n - 1) % n];
        const next = points[(i + 1) % n];
        return `${i === 0 ? 'M' : 'L'}${toward(p, prev)} Q${p[0]},${p[1]} ${toward(p, next)}`;
      })
      .join(' ') + ' Z'
  );
}

/**
 * Pixel's pyramid in 3/4 view: the apex, then the base's left, front and
 * right corners. Corners are rounded so it reads as soft like the others.
 */
const PYRAMID = { apex: [50, 7], left: [8, 86], front: [58, 94], right: [93, 80] } as const;
const PYRAMID_BODY = roundedPolygon([PYRAMID.apex, PYRAMID.left, PYRAMID.front, PYRAMID.right], 6);
const PYRAMID_RIGHT = roundedPolygon([PYRAMID.apex, PYRAMID.front, PYRAMID.right], 6);
const PYRAMID_RIDGE = 'M50.6,13 L57.4,88';
const PYRAMID_CAP = 'M50,10 L43.5,20.5 Q50,23 57.5,20.5 Z';

const NIMBO_PUFFS = [
  { cx: 50, cy: 34, r: 21 },
  { cx: 28, cy: 52, r: 19 },
  { cx: 72, cy: 52, r: 19 },
  { cx: 36, cy: 70, r: 17 },
  { cx: 64, cy: 70, r: 17 },
  { cx: 50, cy: 56, r: 25 },
];

export function BotAvatar({
  avatar,
  state = 'idle',
  size = 'sm',
  className,
  label,
  trackCursor = true,
}: BotAvatarProps) {
  const { hue, eyes, mood, shape } = resolveBotAvatar(avatar);
  const reduce = useReducedMotion() ?? false;
  const px = SIZES[size];
  /** Transcript bubbles: skip feGaussianBlur — dozens on screen at once. */
  const lite = size === 'xs';
  const animated = !reduce;
  // Tiny avatars (one per message bubble) skip cursor tracking: one window
  // listener per bubble adds up on a long thread.
  const tracksCursor = trackCursor && animated && size !== 'xs';
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'av';
  const ref = useRef<SVGSVGElement>(null);
  const blinkClosed = useBlink(animated);

  const lookX = useMotionValue(0);
  const lookY = useMotionValue(0);
  const gazeX = useSpring(lookX, { stiffness: 220, damping: 20 });
  const gazeYSpring = useSpring(lookY, { stiffness: 220, damping: 20 });

  useEffect(() => {
    if (!tracksCursor) return;
    const onMove = (e: PointerEvent) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      const dist = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, dist / 300);
      lookX.set((dx / dist) * 2.5 * reach);
      lookY.set((dy / dist) * 2 * reach);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [tracksCursor, lookX, lookY]);

  // Palette: a soft two-hue pastel gradient (paler and shifted at the
  // top-left, deeper at the bottom-right), and eyes that glow in the bot's
  // colour.
  // Apex is black, its edges lit amber and its eyes white.
  const apex = shape === 'apex';
  const light = `hsl(${(hue + 28) % 360} 90% 95%)`;
  const mid = `hsl(${hue} 72% 82%)`;
  const deep = apex ? 'hsl(240 6% 4%)' : `hsl(${(hue + 335) % 360} 62% 64%)`;
  const rim = apex ? 'hsl(34 96% 64%)' : `hsl(${hue} 100% 66%)`;
  const glow = apex ? 'hsl(40 100% 97%)' : `hsl(${hue} 100% 84%)`;
  const ids = {
    body: `bd-${uid}`,
    shine: `sh-${uid}`,
    shade: `sd-${uid}`,
    visor: `vs-${uid}`,
    glow: `gl-${uid}`,
    front: `fr-${uid}`,
  };
  const bodyFill = `url(#${ids.body})`;
  // The specular highlight and the edge shading go on top of the body
  // gradient, so every body reads as a soft 3D object.
  const shineFill = `url(#${ids.shine})`;
  const shadeFill = `url(#${ids.shade})`;
  const visorFill = `url(#${ids.visor})`;
  const glowFilter = lite ? undefined : `url(#${ids.glow})`;

  const busy = state === 'thinking' || state === 'working';
  const expression = expressionFor(state, eyes);
  const face = FACES[shape];
  const gazeOverride = state === 'thinking' || state === 'error';
  const gazeStyle = gazeOverride ? undefined : { x: gazeX, y: gazeYSpring };
  const gazeAnimate = gazeOverride ? { x: 0, y: state === 'thinking' ? -2 : 1.5 } : {};

  const bodyAnimate = (() => {
    if (!animated) return { y: state === 'error' ? 2 : 0, rotate: 0, scale: 1 };
    switch (state) {
      case 'working':
        return { y: [0, -1.5, 0], rotate: 0, scale: [1, 1.02, 1] };
      case 'happy':
        return { y: [0, -7, 0, -3, 0], rotate: 0, scale: 1 };
      case 'error':
        return { y: 2, rotate: [0, -4, 4, -2, 0], scale: 1 };
      case 'listening':
        return { y: [0, -1.5, 0], rotate: -5, scale: 1 };
      case 'handoff':
        return { y: 0, rotate: 8, scale: 1 };
      default:
        return mood === 'curious'
          ? { y: [0, -2.5, 0], rotate: [-3, 3, -3], scale: 1 }
          : { y: [0, -2.5, 0], rotate: 0, scale: 1 };
    }
  })();
  const bodyTransition: Transition = !animated
    ? { duration: 0.2 }
    : state === 'happy'
      ? { duration: 0.9, ease: 'easeOut' }
      : state === 'error'
        ? { duration: 0.5 }
        : state === 'handoff'
          ? { type: 'spring', stiffness: 160, damping: 14 }
          : { duration: busy ? 1 : mood === 'calm' ? 5 : 3.4, repeat: Infinity, ease: 'easeInOut' };

  const eyesNode = (
    <Eyes
      expression={expression}
      eyes={eyes}
      face={face}
      fill={glow}
      filter={glowFilter}
      blink={blinkClosed}
      animated={animated}
      state={state}
    />
  );

  return (
    <motion.svg
      ref={ref}
      viewBox="0 0 100 100"
      width={px}
      height={px}
      className={cn('shrink-0 overflow-visible', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-avatar-state={state}
      data-avatar-shape={shape}
    >
      <defs>
        <linearGradient id={ids.body} gradientUnits="userSpaceOnUse" x1="18" y1="8" x2="82" y2="96">
          <stop offset="0%" stopColor={light} />
          <stop offset="52%" stopColor={mid} />
          <stop offset="100%" stopColor={deep} />
        </linearGradient>
        <radialGradient id={ids.shine} gradientUnits="userSpaceOnUse" cx="36" cy="26" r="42">
          <stop offset="0%" stopColor="white" stopOpacity={0.75} />
          <stop offset="45%" stopColor="white" stopOpacity={0.18} />
          <stop offset="100%" stopColor="white" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={ids.shade} gradientUnits="userSpaceOnUse" cx="42" cy="38" r="60">
          <stop offset="0%" stopColor={deep} stopOpacity={0} />
          <stop offset="62%" stopColor={deep} stopOpacity={0} />
          <stop offset="100%" stopColor={deep} stopOpacity={0.55} />
        </radialGradient>
        <linearGradient id={ids.visor} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(228 28% 22%)" />
          <stop offset="100%" stopColor="hsl(230 40% 6%)" />
        </linearGradient>
        {!lite && (
          <filter id={ids.glow} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
        <clipPath id={ids.front}>
          <rect x="0" y="54" width="100" height="50" />
        </clipPath>
      </defs>

      {/* Contact shadow: stays on the ground while the body floats. */}
      <ellipse cx={50} cy={96} rx={26} ry={3} fill="black" opacity={0.1} />

      <motion.g style={{ originX: '50px', originY: '90px' }} animate={bodyAnimate} transition={bodyTransition}>
        <Body
          uid={uid}
          shape={shape}
          bodyFill={bodyFill}
          shineFill={shineFill}
          shadeFill={shadeFill}
          visorFill={visorFill}
          glowFilter={glowFilter}
          rim={rim}
          glow={glow}
          deep={deep}
          frontClip={`url(#${ids.front})`}
          busy={busy}
          animated={animated}
        >
          <motion.g style={gazeStyle} animate={gazeAnimate} transition={{ duration: 0.25 }}>
            {eyesNode}
          </motion.g>
        </Body>

        {/* Thinking: three small dots circling the head. */}
        {state === 'thinking' && animated && (
          <motion.g
            style={{ originX: '50px', originY: '50px' }}
            animate={{ rotate: 360 }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
          >
            {[0, 120, 240].map((deg) => (
              <circle
                key={deg}
                cx={50 + 49 * Math.cos((deg * Math.PI) / 180)}
                cy={50 + 49 * Math.sin((deg * Math.PI) / 180)}
                r={2.4}
                fill={rim}
                {...(glowFilter ? { filter: glowFilter } : {})}
              />
            ))}
          </motion.g>
        )}
      </motion.g>
    </motion.svg>
  );
}

/** The body, its visor, and the face drawn on the visor. */
function Body({
  uid,
  shape,
  bodyFill,
  shineFill,
  shadeFill,
  visorFill,
  glowFilter,
  rim,
  glow,
  deep,
  frontClip,
  busy,
  animated,
  children,
}: {
  shape: BotBody;
  bodyFill: string;
  shineFill: string;
  shadeFill: string;
  visorFill: string;
  glowFilter?: string;
  rim: string;
  glow: string;
  deep: string;
  frontClip: string;
  busy: boolean;
  animated: boolean;
  children: ReactNode;
  uid: string;
}) {
  // While working, the visor's edge light pulses.
  const pulse = animated && busy ? { opacity: [0.95, 0.35, 0.95] } : { opacity: 0.85 };
  const pulseTransition: Transition = animated && busy ? { duration: 1, repeat: Infinity } : { duration: 0.2 };
  const visorGloss = (x: number, y: number, w: number) => (
    <ellipse cx={x + w / 2} cy={y + 4.5} rx={w * 0.36} ry={2.2} fill="white" opacity={0.14} />
  );

  switch (shape) {
    case 'apex':
      return (
        <ApexBody uid={uid} rim={rim} glowFilter={glowFilter} pulse={pulse} pulseTransition={pulseTransition}>
          {children}
        </ApexBody>
      );
    case 'nova':
      return (
        <>
          <circle cx={50} cy={52} r={40} fill={bodyFill} />
          <circle cx={50} cy={52} r={40} fill={shadeFill} />
          <circle cx={50} cy={52} r={40} fill={shineFill} />
          {/* The rim light around the back edge. */}
          <motion.path
            d={arcPath(50, 52, 39, 110, 250)}
            fill="none"
            stroke={rim}
            strokeWidth={2.4}
            strokeLinecap="round"
            {...(glowFilter ? { filter: glowFilter } : {})}
            animate={pulse}
            transition={pulseTransition}
          />
          <rect x={33} y={36} width={48} height={32} rx={16} fill={visorFill} />
          <rect x={33} y={36} width={48} height={32} rx={16} fill="none" stroke="white" strokeOpacity={0.55} strokeWidth={1.4} />
          {visorGloss(33, 36, 48)}
          {children}
        </>
      );
    case 'hexa':
      return (
        <>
          {HEXA_PETALS.map((p) => (
            <g key={`${p.cx}-${p.cy}`}>
              <path d={hexPath(p.cx, p.cy, 15.5)} fill={bodyFill} stroke="white" strokeOpacity={0.5} strokeWidth={1} strokeLinejoin="round" />
              <path d={hexPath(p.cx, p.cy, 15.5)} fill={shadeFill} />
              <path d={hexPath(p.cx, p.cy, 15.5)} fill={shineFill} />
            </g>
          ))}
          <motion.path
            d={hexPath(50, 50, 19.5)}
            fill="none"
            stroke={rim}
            strokeWidth={2.2}
            strokeLinejoin="round"
            {...(glowFilter ? { filter: glowFilter } : {})}
            animate={pulse}
            transition={pulseTransition}
          />
          <path d={hexPath(50, 50, 18.5)} fill={visorFill} strokeLinejoin="round" />
          {children}
        </>
      );
    case 'nimbo':
      return (
        <>
          {NIMBO_PUFFS.map((p) => (
            <circle key={`${p.cx}-${p.cy}`} cx={p.cx} cy={p.cy} r={p.r} fill={bodyFill} />
          ))}
          {NIMBO_PUFFS.map((p) => (
            <circle key={`d-${p.cx}-${p.cy}`} cx={p.cx} cy={p.cy} r={p.r} fill={shadeFill} opacity={0.5} />
          ))}
          {NIMBO_PUFFS.map((p) => (
            <circle key={`s-${p.cx}-${p.cy}`} cx={p.cx} cy={p.cy} r={p.r} fill={shineFill} opacity={0.6} />
          ))}
          <rect x={28} y={43} width={44} height={27} rx={13.5} fill="white" opacity={0.75} />
          <motion.rect
            x={30}
            y={45}
            width={40}
            height={23}
            rx={11.5}
            fill={visorFill}
            stroke={rim}
            strokeWidth={0.8}
            animate={pulse}
            transition={pulseTransition}
          />
          {visorGloss(30, 45, 40)}
          {children}
        </>
      );
    case 'orbit':
      return (
        <>
          {/* The ring behind the planet, then the planet, then the ring's front half. */}
          <ellipse cx={50} cy={56} rx={47} ry={12} transform="rotate(-12 50 56)" fill="none" stroke={deep} strokeWidth={2.4} opacity={0.75} />
          <circle cx={50} cy={50} r={35} fill={bodyFill} />
          <circle cx={50} cy={50} r={35} fill={shadeFill} />
          <circle cx={50} cy={50} r={35} fill={shineFill} />
          <ellipse
            cx={50}
            cy={56}
            rx={47}
            ry={12}
            transform="rotate(-12 50 56)"
            fill="none"
            stroke={rim}
            strokeWidth={2.4}
            clipPath={frontClip}
          />
          <rect x={28} y={33} width={48} height={31} rx={15.5} fill={visorFill} />
          {visorGloss(28, 33, 48)}
          {children}
          {/* The moon riding the ring. */}
          <circle cx={13} cy={72} r={6.5} fill={glow} {...(glowFilter ? { filter: glowFilter } : {})} />
          <circle cx={11.5} cy={70} r={2.4} fill="white" opacity={0.8} />
        </>
      );
    case 'pixel':
      return (
        <>
          {/* Two faces in 3/4 view: the left lit, the right in shade. */}
          <path d={PYRAMID_BODY} fill={bodyFill} />
          <path d={PYRAMID_BODY} fill={shadeFill} />
          <path d={PYRAMID_BODY} fill={shineFill} />
          <path d={PYRAMID_RIGHT} fill={deep} opacity={0.32} />
          <path d={PYRAMID_BODY} fill="none" stroke="white" strokeOpacity={0.6} strokeWidth={1.4} strokeLinejoin="round" />
          <path d={PYRAMID_RIDGE} fill="none" stroke="white" strokeOpacity={0.45} strokeWidth={1.1} strokeLinecap="round" />
          {/* The lit capstone. */}
          <motion.path
            d={PYRAMID_CAP}
            fill={glow}
            stroke={glow}
            strokeWidth={1.5}
            strokeLinejoin="round"
            {...(glowFilter ? { filter: glowFilter } : {})}
            animate={pulse}
            transition={pulseTransition}
          />
          <rect x={29} y={54} width={44} height={24} rx={12} fill={visorFill} />
          {visorGloss(29, 54, 44)}
          {children}
        </>
      );
  }
}

const APEX_CENTRE = { x: 50, y: 52 };

/**
 * Brain Bot's body: a glossy black sphere with a large bezelled black visor,
 * an amber light along its lower-right edge and the visor's right edge.
 */
function ApexBody({
  uid,
  rim,
  glowFilter,
  pulse,
  pulseTransition,
  children,
}: {
  uid: string;
  rim: string;
  glowFilter?: string;
  pulse: { opacity: number | number[] };
  pulseTransition: Transition;
  children: ReactNode;
}) {
  const ids = {
    sphere: `apx-sp-${uid}`,
    gloss: `apx-gl-${uid}`,
    bezel: `apx-bz-${uid}`,
    visor: `apx-vs-${uid}`,
  };
  const { x: cx, y: cy } = APEX_CENTRE;
  return (
    <>
      <defs>
        <radialGradient id={ids.sphere} gradientUnits="userSpaceOnUse" cx="36" cy="30" r="52">
          <stop offset="0%" stopColor="hsl(240 3% 34%)" />
          <stop offset="34%" stopColor="hsl(240 4% 12%)" />
          <stop offset="100%" stopColor="hsl(240 8% 2%)" />
        </radialGradient>
        <radialGradient id={ids.gloss} gradientUnits="userSpaceOnUse" cx="34" cy="26" r="18">
          <stop offset="0%" stopColor="white" stopOpacity={0.35} />
          <stop offset="100%" stopColor="white" stopOpacity={0} />
        </radialGradient>
        <linearGradient id={ids.bezel} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="hsl(240 3% 44%)" />
          <stop offset="50%" stopColor="hsl(240 5% 12%)" />
          <stop offset="100%" stopColor="hsl(240 4% 26%)" />
        </linearGradient>
        <linearGradient id={ids.visor} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(240 6% 9%)" />
          <stop offset="100%" stopColor="hsl(240 10% 1%)" />
        </linearGradient>
      </defs>

      <circle cx={cx} cy={cy} r={38} fill={`url(#${ids.sphere})`} />
      <circle cx={cx} cy={cy} r={38} fill={`url(#${ids.gloss})`} />
      {/* A faint edge, so the sphere holds its outline on a dark page. */}
      <circle cx={cx} cy={cy} r={37.6} fill="none" stroke="white" strokeOpacity={0.12} strokeWidth={0.7} />
      {/* The amber light along the lower-right edge. */}
      <motion.path
        d={arcPath(cx, cy, 37, 15, 75)}
        fill="none"
        stroke={rim}
        strokeWidth={1.1}
        strokeLinecap="round"
        strokeOpacity={0.85}
        {...(glowFilter ? { filter: glowFilter } : {})}
        animate={pulse}
        transition={pulseTransition}
      />

      {/* The visor: a thick lit bezel round a deep black glass, amber along its right edge. */}
      <rect x={24} y={34} width={56} height={36} rx={18} fill={`url(#${ids.bezel})`} />
      <rect x={27.5} y={37.5} width={49} height={29} rx={14.5} fill={`url(#${ids.visor})`} />
      <motion.path
        d="M68 36.6 A16 16 0 0 1 79.2 49"
        fill="none"
        stroke={rim}
        strokeWidth={0.9}
        strokeLinecap="round"
        {...(glowFilter ? { filter: glowFilter } : {})}
        animate={pulse}
        transition={pulseTransition}
      />
      <ellipse cx={52} cy={40.2} rx={15} ry={1.4} fill="white" opacity={0.12} />
      {children}
    </>
  );
}

/** The glowing eyes on the visor, drawn for the current expression. */
function Eyes({
  expression,
  eyes,
  face,
  fill,
  filter,
  blink,
  animated,
  state,
}: {
  expression: Expression;
  eyes: BotEyeStyle;
  face: Face;
  fill: string;
  filter?: string;
  blink: boolean;
  animated: boolean;
  state: AvatarState;
}) {
  const { cx, cy, k } = face;
  const gap = 9.5 * k;
  const xs = [cx - gap, cx + gap];
  const stroke = { fill: 'none', stroke: fill, strokeWidth: 2.8 * k, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const fl = filter ? { filter } : {};

  switch (expression) {
    case 'happy':
      return (
        <g {...fl}>
          {xs.map((x) => (
            <path key={x} d={`M${x - 4.5 * k},${cy + 2.5 * k} Q${x},${cy - 5 * k} ${x + 4.5 * k},${cy + 2.5 * k}`} {...stroke} />
          ))}
        </g>
      );
    case 'sleepy':
      return (
        <g {...fl}>
          {xs.map((x) => (
            <path key={x} d={`M${x - 4.5 * k},${cy - 1.5 * k} Q${x},${cy + 4.5 * k} ${x + 4.5 * k},${cy - 1.5 * k}`} {...stroke} />
          ))}
        </g>
      );
    case 'thinking':
      return (
        <g {...fl}>
          {xs.map((x) => (
            <rect key={x} x={x - 4.5 * k} y={cy - 1.4 * k} width={9 * k} height={2.8 * k} rx={1.4 * k} fill={fill} />
          ))}
        </g>
      );
    case 'excited':
      return (
        <g {...fl}>
          <path d={`M${xs[0]! - 3.5 * k},${cy - 4.5 * k} L${xs[0]! + 3.5 * k},${cy} L${xs[0]! - 3.5 * k},${cy + 4.5 * k}`} {...stroke} />
          <path d={`M${xs[1]! + 3.5 * k},${cy - 4.5 * k} L${xs[1]! - 3.5 * k},${cy} L${xs[1]! + 3.5 * k},${cy + 4.5 * k}`} {...stroke} />
        </g>
      );
    case 'surprised':
      return (
        <g {...fl}>
          {xs.map((x) => (
            <circle key={x} cx={x} cy={cy} r={3.6 * k} {...stroke} strokeWidth={2.3 * k} />
          ))}
        </g>
      );
    case 'wink':
      return (
        <g {...fl}>
          <rect x={xs[0]! - 2.6 * k} y={cy - 6.5 * k} width={5.2 * k} height={13 * k} rx={2.6 * k} fill={fill} />
          <rect x={xs[1]! - 4.5 * k} y={cy - 1.4 * k} width={9 * k} height={2.8 * k} rx={1.4 * k} fill={fill} />
        </g>
      );
    default: {
      // Neutral, wide (listening): upright pills, or one wide bar for a
      // single-eyed bot. They blink, flutter while talking and scan while
      // working.
      const wide = expression === 'wide';
      const w = (wide ? 6 : 5.2) * k;
      const h = (wide ? 15 : 13) * k;
      const pills =
        eyes === 'mono'
          ? [{ x: cx - 11 * k, w: 22 * k, h: 9 * k }]
          : xs.map((x) => ({ x: x - w / 2, w, h }));
      const talking = animated && state === 'talking';
      const working = animated && state === 'working';
      return (
        <motion.g
          {...fl}
          style={{ originX: `${cx}px`, originY: `${cy}px` }}
          animate={{
            scaleY: blink ? 0.12 : talking ? [1, 0.6, 1] : 1,
            x: working ? [-2.5, 2.5, -2.5] : 0,
          }}
          transition={
            blink
              ? { duration: 0.08 }
              : talking
                ? { duration: 0.32, repeat: Infinity, ease: 'easeInOut' }
                : working
                  ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' }
                  : { duration: 0.12 }
          }
        >
          {pills.map((p) => (
            <rect key={p.x} x={p.x} y={cy - p.h / 2} width={p.w} height={p.h} rx={Math.min(p.w, p.h) / 2} fill={fill} />
          ))}
          {eyes === 'sparkle' &&
            pills.map((p) => (
              <circle key={`g-${p.x}`} cx={p.x + p.w * 0.7} cy={cy - p.h * 0.22} r={0.9 * k} fill="white" />
            ))}
        </motion.g>
      );
    }
  }
}
