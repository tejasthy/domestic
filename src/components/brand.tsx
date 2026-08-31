import * as React from 'react';

/**
 * Domestic mark: a maize gable over a blue block. Reads at 20px on a tab bar
 * and at 200px on the kiosk splash, which is the whole job.
 */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden
    >
      <rect width="32" height="32" rx="7" className="fill-blue dark:fill-maize" />
      <path d="M16 7L26 15.5H23.2V25H8.8V15.5H6L16 7Z" className="fill-maize dark:fill-blue" />
      <rect x="13.4" y="18.5" width="5.2" height="6.5" rx="1" className="fill-blue dark:fill-maize" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={className}>
      <span className="t-title-lg font-display uppercase tracking-[0.14em] text-ink">
        Domestic
      </span>
    </span>
  );
}

/* --------------------------------------------------------------------------
   Icon set — 24px grid, 1.75 stroke, round caps. Kept inline so there is no
   icon-font request on a cold phone load.
-------------------------------------------------------------------------- */

type IconProps = { size?: number; className?: string };

function base(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
  };
}

export const Icon = {
  Home: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </svg>
  ),
  Chores: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M4 6.5h4M4 12h4M4 17.5h4" />
      <path d="M11.5 6.5H20M11.5 12H20M11.5 17.5H20" />
    </svg>
  ),
  Money: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M12 3v18" />
      <path d="M16.5 7.5c0-1.7-2-2.8-4.5-2.8S7.5 5.8 7.5 7.8s2 2.6 4.5 3.1 4.5 1.2 4.5 3.2-2 3-4.5 3-4.5-1.1-4.5-2.8" />
    </svg>
  ),
  Chart: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M8 20v-6M12.5 20V8M17 20v-9" />
    </svg>
  ),
  Check: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  ),
  Plus: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Camera: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M3 8.5a2 2 0 0 1 2-2h2l1.3-2h7.4L17 6.5h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  ),
  Bell: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" />
      <path d="M10 18.5a2 2 0 0 0 4 0" />
    </svg>
  ),
  Settings: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
  Swap: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" />
    </svg>
  ),
  Clock: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  Close: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  ),
  SkipForward: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M6 5.5v13l9.5-6.5z" />
      <path d="M17.5 5.5v13" />
    </svg>
  ),
  Undo: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M7 8H5V6" />
      <path d="M5 8c1.7-2.3 4.3-3.5 7-3.5 4.4 0 8 3.4 8 7.5s-3.6 7.5-8 7.5c-3 0-5.7-1.6-7-4" />
    </svg>
  ),
  Sun: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  ),
  Moon: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <path d="M20 13.5A8.5 8.5 0 1 1 10.5 4a7 7 0 0 0 9.5 9.5Z" />
    </svg>
  ),
  Monitor: ({ size = 24, className }: IconProps) => (
    <svg {...base(size, className)}>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" />
      <path d="M8.5 20h7M12 16.5V20" />
    </svg>
  ),
};
