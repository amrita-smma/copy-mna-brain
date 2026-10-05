'use client';

interface LivingBackgroundProps {
  /**
   * Grid keeps a darker ink/midnight-blue palette for login/auth pages. Plain is
   * the flat SQE Suite page colour, with no gradient or earth photo, behind the
   * dense Pipeline and Sourcing tables (MB-648).
   */
  variant?: 'default' | 'grid' | 'plain';
}

const LIGHT_GRADIENT =
  'linear-gradient(160deg, #F0FFFF 0%, #E0F2F7 45%, #E8F4F8 100%)';
const DARK_GRADIENT =
  'linear-gradient(160deg, #0F1A28 0%, #1E2A3B 35%, #2A4B7D 65%, #1E2A3B 100%)';
const GRID_GRADIENT =
  'linear-gradient(160deg, #0C0C10 0%, #141a33 35%, #22357a 65%, #12172b 100%)';
/** SQE Suite page surface: neutral-50 (light) and neutral-1000 (dark). */
const PLAIN_LIGHT = '#F9FAFC';
const PLAIN_DARK = '#13171C';

export function LivingBackground({ variant = 'default' }: LivingBackgroundProps) {
  const isPlain = variant === 'plain';

  return (
    <div
      className="fixed inset-0 z-0 pointer-events-none overflow-hidden"
      aria-hidden
    >
      {variant === 'grid' ? (
        <div className="absolute inset-0" style={{ background: GRID_GRADIENT }} />
      ) : (
        <>
          <div
            className="absolute inset-0 dark:opacity-0"
            style={{ background: isPlain ? PLAIN_LIGHT : LIGHT_GRADIENT }}
          />
          <div
            className="absolute inset-0 opacity-0 dark:opacity-100"
            style={{ background: isPlain ? PLAIN_DARK : DARK_GRADIENT }}
          />
          {!isPlain && (
            <div
              className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-[0.5]"
              style={{ backgroundImage: 'url(/hero-earth-overlay.png)' }}
            />
          )}
        </>
      )}
    </div>
  );
}
