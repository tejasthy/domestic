import Link from 'next/link';
import { Logo, Wordmark } from '@/components/brand';

const REPO = 'https://github.com/tejasthy/domestic';

/**
 * Nav and footer for the pages the public can reach logged out — the
 * marketing page and the two legal ones. Shared so the footer's legal links
 * are declared in exactly one place.
 */

export function SiteNav() {
  return (
    <header className="sticky top-0 z-30 bg-page/90 backdrop-blur border-b border-subtle">
      <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <Logo size={26} />
          <Wordmark />
        </Link>
        <Link href="/login" className="t-body-sm font-semibold text-ink hover:text-accent transition-colors">
          Sign in
        </Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-subtle">
      <div className="max-w-5xl mx-auto px-6 py-10 flex flex-col sm:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-2.5">
          <Logo size={22} />
          <span className="t-body-sm text-ink-muted">
            Domestic — hold your roommates accountable. Free & open source.
          </span>
        </div>
        <nav className="flex items-center gap-5">
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className="t-body-sm text-ink-muted hover:text-ink transition-colors"
          >
            GitHub
          </a>
          <Link href="/privacy" className="t-body-sm text-ink-muted hover:text-ink transition-colors">
            Privacy
          </Link>
          <Link href="/terms" className="t-body-sm text-ink-muted hover:text-ink transition-colors">
            Terms
          </Link>
          <Link href="/login" className="t-body-sm font-semibold text-accent">
            Sign in →
          </Link>
        </nav>
      </div>
    </footer>
  );
}
