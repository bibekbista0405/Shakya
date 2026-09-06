"use client";

import Link, { LinkProps } from "next/link";
import { AnchorHTMLAttributes, ReactNode } from "react";

interface FastNavLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">,
    Omit<LinkProps, "href"> {
  href: string;
  children: ReactNode;
}

/**
 * Lightweight navigation wrapper.
 *
 * Keep navigation on the native Next Link path. We additionally prefetch only
 * the route the user is actually pointing at, avoiding the request burst caused
 * by warming every route at once.
 */
export function FastNavLink({ href, children, ...props }: FastNavLinkProps) {
  return (
    <Link {...props} href={href} prefetch>
      {children}
    </Link>
  );
}
