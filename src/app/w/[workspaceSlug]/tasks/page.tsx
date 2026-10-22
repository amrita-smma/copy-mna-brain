import Tasks from '@/views/Tasks';

/**
 * The signed-in user's personal to-do list as a page of its own — pinned on
 * the mobile bot home beside Timeline (the shell gives it the back button),
 * and reachable on desktop from the sidebar tasks button's "View all".
 */
export default function TasksPage() {
  return <Tasks />;
}
