'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import * as React from 'react';
import { Icon } from '@/components/brand';
import { cx } from '@/components/ui';
import { navFor } from '@/lib/modules';

const ICONS = {
  Chores: Icon.Chores,
  Money: Icon.Money,
  Chart: Icon.Chart,
} as const;

type Tab = { href: string; label: string; icon: React.ComponentType<{ size?: number }> };

/** Today, Activity, and You always exist; everything between Today and
 * Activity is module-driven. Activity spans chores + expenses both, so it
 * isn't owned by either module the way the kiosk's "Lately" feed is. */
function tabsFor(modules: string[]): Tab[] {
  return [
    { href: '/', label: 'Today', icon: Icon.Home },
    ...navFor(modules).map((n) => ({ href: n.href, label: n.label, icon: ICONS[n.icon] })),
    { href: '/activity', label: 'Activity', icon: Icon.Clock },
    { href: '/settings', label: 'You', icon: Icon.Settings },
  ];
}

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

/** Phone-first: a thumb-reachable tab bar pinned to the bottom. */
export function TabBar({ modules }: { modules: string[] }) {
  const pathname = usePathname();
  const tabs = tabsFor(modules);

  return (
    <nav
      className={cx(
        'md:hidden fixed bottom-0 inset-x-0 z-40',
        'bg-card/95 backdrop-blur border-t border-subtle pb-safe',
      )}
    >
      <ul className="flex">
        {tabs.map(({ href, label, icon: Ico }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex flex-col items-center gap-0.5 py-2 transition-colors duration-[120ms]',
                  active ? 'text-accent' : 'text-ink-muted',
                )}
              >
                <Ico size={22} />
                <span className="t-caption">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Laptops and the tablet in landscape get a rail instead. */
export function SideNav({ modules }: { modules: string[] }) {
  const pathname = usePathname();
  const tabs = tabsFor(modules);

  return (
    <nav className="hidden md:block">
      <ul className="space-y-1">
        {tabs.map(({ href, label, icon: Ico }) => {
          const active = isActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex items-center gap-3 px-3 h-11 rounded-md t-body-md font-medium',
                  'transition-colors duration-[120ms]',
                  active
                    ? 'bg-maize/25 text-ink font-semibold'
                    : 'text-ink-2 hover:bg-hover',
                )}
              >
                <Ico size={20} />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
