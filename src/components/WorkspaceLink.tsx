'use client';

import Link, { LinkProps } from 'next/link';
import { ComponentProps } from 'react';
import { useWorkspaceHref } from '@/hooks/useWorkspaceHref';

type WorkspaceLinkProps = Omit<ComponentProps<typeof Link>, 'href'> & {
  href: string;
} & Omit<LinkProps, 'href'>;

/**
 * Drop-in replacement for `next/link`'s `Link` that prefixes `href` with the
 * current tab's workspace slug (`useWorkspaceHref`). Use for every internal
 * link to a workspace-scoped route.
 */
export function WorkspaceLink({ href, ...rest }: WorkspaceLinkProps) {
  const workspaceHref = useWorkspaceHref(href);
  return <Link href={workspaceHref} {...rest} />;
}
