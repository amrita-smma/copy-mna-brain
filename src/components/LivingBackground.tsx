'use client';

interface LivingBackgroundProps {
  /** Grid variant keeps a darker ink/midnight-blue palette for login/auth pages. */
  variant?: 'default' | 'grid';
}

const LIGHT_GRADIENT =
  'linear-gradient(160deg, #F0FFFF 0%, #E0F2F7 45%, #E8F4F8 100%)';
const DARK_GRADIENT =
  'linear-gradient(160deg, #0F1A28 0%, #1E2A3B 35%, #2A4B7D 65%, #1E2A3B 100%)';
const GRID_GRADIENT =
  'linear-gradient(160deg, #0C0C10 0%, #141a33 35%, #22357a 65%, #12172b 100%)';

export function LivingBackground({ variant = 'default' }: LivingBackgroundProps) {
  const isGridVariant = variant === 'grid';

  return (
    <div
      className="fixed inset-0 z-0 pointer-events-none overflow-hidden"
      aria-hidden
    >
      {isGridVariant ? (
        <div className="absolute inset-0" style={{ background: GRID_GRADIENT }} />
      ) : (
        <>
          <div
            className="absolute inset-0 dark:opacity-0"
            style={{ background: LIGHT_GRADIENT }}
          />
          <div
            className="absolute inset-0 opacity-0 dark:opacity-100"
            style={{ background: DARK_GRADIENT }}
          />
          <div
            className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-[0.5]"
            style={{ backgroundImage: 'url(/hero-earth-overlay.png)' }}
          />
        </>
      )}
    </div>
  );
}
