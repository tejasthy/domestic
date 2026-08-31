'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setTheme } from '@/lib/actions';
import { Icon } from '@/components/brand';
import { cx } from '@/components/ui';
import type { ThemeMode } from '@/lib/theme';

const OPTIONS: { value: ThemeMode; label: string; icon: 'Monitor' | 'Sun' | 'Moon' }[] = [
  { value: 'system', label: 'System', icon: 'Monitor' },
  { value: 'light', label: 'Light', icon: 'Sun' },
  { value: 'dark', label: 'Dark', icon: 'Moon' },
];

/** Per-device preference — see setTheme() in actions.ts. `compact` drops the
 * label for the kiosk header, which has no room to spare. */
export function ThemeToggle({ current, compact }: { current: ThemeMode; compact?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(current);
  const [pending, start] = useTransition();

  function choose(theme: ThemeMode) {
    if (theme === value) return;
    setValue(theme);
    start(async () => {
      await setTheme(theme);
      router.refresh();
    });
  }

  return (
    <div className={cx('flex items-center', compact ? 'gap-1.5' : 'gap-2')}>
      {OPTIONS.map(({ value: v, label, icon }) => {
        const Icn = Icon[icon];
        const selected = v === value;
        return (
          <button
            key={v}
            type="button"
            disabled={pending}
            onClick={() => choose(v)}
            aria-label={label}
            aria-pressed={selected}
            className={cx(
              'flex items-center gap-1.5 rounded-pill border transition-colors duration-[120ms] disabled:opacity-50',
              compact ? 'w-9 h-9 justify-center' : 'pl-2.5 pr-3.5 py-1.5',
              selected ? 'border-accent bg-accent/10 text-ink' : 'border-line bg-card hover:bg-hover text-ink-2',
            )}
          >
            <Icn size={compact ? 18 : 16} />
            {!compact && <span className="t-body-sm font-medium">{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
