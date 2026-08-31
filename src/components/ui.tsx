import * as React from 'react';
import Link from 'next/link';

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

/**
 * Tailwind's generated stylesheet orders utilities by its own scale, not by
 * class-attribute order — so `w-full` always wins over a later `w-24` in the
 * same class list. Strip base classes whose prefix (w-/h-/etc.) is also
 * overridden, so callers can actually resize a shared component.
 */
function cxOverride(base: string, override: string | undefined, prefixes: string[]) {
  if (!override) return base;
  const overridden = prefixes.filter((p) => override.split(/\s+/).some((c) => c.startsWith(p)));
  const filteredBase = base
    .split(/\s+/)
    .filter((c) => !overridden.some((p) => c.startsWith(p)))
    .join(' ');
  return cx(filteredBase, override);
}

/* ------------------------------------------------------------------ surface */

export function Card({
  className,
  as: Tag = 'div',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { as?: React.ElementType }) {
  return (
    <Tag
      className={cx(
        'bg-card border border-subtle rounded-lg shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

export function SectionHeader({
  title,
  action,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex items-baseline justify-between gap-3 mb-3', className)}>
      <h2 className="t-label text-ink-muted">{title}</h2>
      {action}
    </div>
  );
}

export function EmptyState({
  emoji,
  title,
  hint,
}: {
  emoji: string;
  title: string;
  hint?: string;
}) {
  return (
    <div className="text-center py-10 px-6">
      <div className="text-4xl mb-3" aria-hidden>
        {emoji}
      </div>
      <p className="t-title-md text-ink">{title}</p>
      {hint && <p className="t-body-sm text-ink-muted mt-1">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ buttons */

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger';

const TONE: Record<ButtonTone, string> = {
  // Maize on blue is the signature pairing; it also passes contrast as a
  // dark-text-on-yellow button, which the blue-on-blue alternative does not.
  primary:
    'bg-blue text-white hover:bg-[#003a70] active:bg-[#001c38] dark:bg-maize dark:text-blue dark:hover:bg-[#ffd633]',
  secondary:
    'bg-card text-ink border border-line hover:bg-hover active:bg-sunken',
  ghost: 'text-ink-2 hover:bg-hover active:bg-sunken',
  danger: 'bg-danger text-white hover:opacity-90 active:opacity-80',
};

const SIZE = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-10 px-4 text-[14px] gap-2',
  lg: 'h-12 px-5 text-[16px] gap-2',
  xl: 'h-16 px-7 text-[20px] gap-3',
} as const;

type ButtonProps = {
  tone?: ButtonTone;
  size?: keyof typeof SIZE;
  full?: boolean;
};

export function buttonClass({
  tone = 'primary',
  size = 'md',
  full,
}: ButtonProps = {}) {
  return cx(
    'inline-flex items-center justify-center rounded-md font-semibold',
    'transition-colors duration-[120ms] disabled:opacity-50 disabled:pointer-events-none',
    'select-none whitespace-nowrap',
    TONE[tone],
    SIZE[size],
    full && 'w-full',
  );
}

export function Button({
  tone,
  size,
  full,
  className,
  ...props
}: ButtonProps & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cx(buttonClass({ tone, size, full }), className)} {...props} />;
}

export function LinkButton({
  tone,
  size,
  full,
  className,
  ...props
}: ButtonProps & React.ComponentProps<typeof Link>) {
  return <Link className={cx(buttonClass({ tone, size, full }), className)} {...props} />;
}

/* ------------------------------------------------------------------- people */

/** Initials chip — the digital version of initialing a box on the chart. */
export function Initials({
  initials,
  color,
  size = 'md',
  dim,
  className,
}: {
  initials: string;
  color: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  dim?: boolean;
  className?: string;
}) {
  const dims = {
    sm: 'w-6 h-6 text-[10px]',
    md: 'w-9 h-9 text-[13px]',
    lg: 'w-12 h-12 text-[17px]',
    xl: 'w-20 h-20 text-[28px]',
  }[size];

  return (
    <span
      className={cx(
        'inline-flex items-center justify-center rounded-pill font-mono font-semibold',
        'text-white shrink-0 tracking-wide',
        dims,
        dim && 'opacity-40',
        className,
      )}
      style={{ backgroundColor: color }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

/* -------------------------------------------------------------------- pills */

type PillTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const PILL: Record<PillTone, string> = {
  neutral: 'bg-sunken text-ink-2 border-subtle',
  success: 'bg-success/12 text-success border-success/25',
  warning: 'bg-warning/12 text-warning border-warning/25',
  danger: 'bg-danger/12 text-danger border-danger/25',
  info: 'bg-info/12 text-info border-info/25',
  accent: 'bg-maize/25 text-ink border-maize/60',
};

export function Pill({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: PillTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 t-caption',
        PILL[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------- inputs */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      <span className="t-label text-ink-muted block mb-1.5">{label}</span>
      {children}
      {hint && <span className="t-body-sm text-ink-muted block mt-1">{hint}</span>}
    </label>
  );
}

export const inputClass = cx(
  'w-full h-11 px-3 rounded-md bg-card text-ink border border-line',
  'placeholder:text-ink-muted transition-colors duration-[120ms]',
  'focus:border-info focus:outline-none focus:ring-2 focus:ring-info/25',
);

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const base = cxOverride(inputClass, props.className, ['w-', 'h-']);
  return <input {...props} className={cx(base, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const base = cxOverride(cx(inputClass, 'pr-8'), props.className, ['w-', 'h-']);
  return <select {...props} className={cx(base, props.className)} />;
}
