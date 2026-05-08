'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  // For dynamic routes match the prefix; for "/" require exact match.
  const isActive =
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} className={`kb-nav__link ${isActive ? 'active' : ''}`}>
      {label}
    </Link>
  );
}
