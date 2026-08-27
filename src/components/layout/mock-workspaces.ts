/**
 * FRONTEND MOCKUP ONLY.
 *
 * Shared workspace list used by the post-sign-in workspace picker
 * (`src/app/workspace/page.tsx`) and the sidebar workspace switcher
 * (`AppShell`). There is no workspace/tenant concept on the backend yet
 * — selecting a workspace simply routes into the app at `href`. Once real
 * multi-tenancy lands (see `getActiveWorkspaceId()` in `src/lib/workspace.ts`),
 * this constant is replaced by a fetch of the user's `user_workspaces`.
 */
export interface MockWorkspace {
  /** Stable id used to track the active workspace in localStorage. */
  id: string;
  /** Two-letter avatar initials shown in the gradient tile. */
  initials: string;
  name: string;
  category: string;
  /** Route target — mocked, everything lands on `/chat` for now. */
  href: string;
}

export const MOCK_WORKSPACES: MockWorkspace[] = [
  { id: 'mna', initials: 'MA', name: 'MnA', category: 'M&A Intelligence', href: '/chat' },
  { id: 'starhouse-prime-vcc', initials: 'ST', name: 'Starhouse Prime VCC', category: 'Fund Intelligence', href: '/chat' },
  { id: 'togan-vcc', initials: 'TG', name: 'Togan VCC', category: 'Fund Intelligence', href: '/chat' },
  { id: 'aeliana-vcc', initials: 'AE', name: 'Aeliana VCC', category: 'Fund Intelligence', href: '/chat' },
  { id: 'startech-vcc', initials: 'ST', name: 'Startech VCC', category: 'Fund Intelligence', href: '/chat' },
  { id: 'nanjing-fund', initials: 'NJ', name: 'Nanjing Fund', category: 'Fund Intelligence', href: '/chat' },
];

/** The workspace shown as active before the user picks one. */
export const DEFAULT_WORKSPACE_ID = MOCK_WORKSPACES[0].id;

/** localStorage key holding the id of the currently-active workspace. */
export const ACTIVE_WORKSPACE_STORAGE_KEY = 'workspace:active-id';
