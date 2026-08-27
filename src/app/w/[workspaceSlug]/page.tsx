/**
 * The workspace landing page: the copilot, full-screen.
 *
 * There is deliberately no content here. `AppShell` recognises this route as the
 * chat landing and gives the whole console to the copilot pane, hiding the tab
 * strip — so anything rendered here would be invisible behind it. Collapsing the
 * copilot navigates to a real tab route, which is what supplies the console's
 * content from then on.
 */
export default function WorkspaceLandingPage() {
  return null;
}
