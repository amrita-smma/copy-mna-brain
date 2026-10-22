'use client';

import Link, { LinkProps } from 'next/link';
import { ComponentProps, forwardRef } from 'react';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';

type WorkspaceLinkProps = Omit<ComponentProps<typeof Link>, 'href'> & {
  href: string;
} & Omit<LinkProps, 'href'>;

/**
 * Drop-in replacement for `next/link`'s `Link` that prefixes `href` with the
 * current tab's workspace slug (`useWorkspaceHref`). Use for every internal
 * link to a workspace-scoped route.
 */
export const WorkspaceLink = forwardRef<HTMLAnchorElement, WorkspaceLinkProps>(function WorkspaceLink(
  { href, ...rest },
  ref,
) {
  const workspaceHref = useWorkspaceHref(href);
  return <Link ref={ref} href={workspaceHref} {...rest} />;
});
