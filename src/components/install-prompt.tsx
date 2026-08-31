'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Card } from '@/components/ui';
import { Logo } from '@/components/brand';

/* ---------------------------------------------------------------- detection */

type Platform = 'ssr' | 'installed' | 'ios' | 'android' | 'desktop';

function detectPlatform(): Platform {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (standalone) return 'installed';

  const ua = navigator.userAgent;
  if (/iP(hone|ad|od)/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

function usePlatform(): Platform {
  return useSyncExternalStore(
    () => () => {},
    detectPlatform,
    () => 'ssr' as const,
  );
}

/** Dismissal is per-device on purpose: installing is a per-device act. */
const DISMISS_KEY = 'domestic.install.dismissed';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    // Private windows and blocked site data throw on access.
    return false;
  }
}

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };

/* ------------------------------------------------------------------ prompt */

export function InstallPrompt() {
  const platform = usePlatform();
  // Read through useSyncExternalStore so there is no setState-on-mount; the
  // server snapshot is `true` (hidden) so the banner never flashes during SSR.
  const storedDismissed = useSyncExternalStore(
    () => () => {},
    readDismissed,
    () => true,
  );
  const [justDismissed, setJustDismissed] = useState(false);
  const dismissed = storedDismissed || justDismissed;

  const [deferred, setDeferred] = useState<InstallEvent | null>(null);
  const [showIosSteps, setShowIosSteps] = useState(false);

  useEffect(() => {
    // Chrome/Edge fire this instead of showing their own banner once we
    // preventDefault; iOS Safari never fires it, hence the manual steps below.
    function onBeforeInstall(event: Event) {
      event.preventDefault();
      setDeferred(event as InstallEvent);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  function dismiss() {
    setJustDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Nothing to do — it just reappears next visit.
    }
  }

  if (platform === 'ssr' || platform === 'installed' || dismissed) return null;
  // Desktop with no install support: nothing useful to offer.
  if (platform === 'desktop' && !deferred) return null;

  return (
    <>
      <div className="fixed inset-x-0 bottom-0 z-50 p-3 pb-safe md:hidden">
        <Card className="p-3.5 shadow-lg flex items-center gap-3">
          <Logo size={36} />
          <div className="min-w-0 flex-1">
            <p className="t-body-md text-ink font-semibold">Add Domestic to your phone</p>
            <p className="t-body-sm text-ink-muted">
              {platform === 'ios'
                ? 'Needed for notifications on iPhone.'
                : 'Opens full screen, and enables notifications.'}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              if (platform === 'ios') setShowIosSteps(true);
              else if (deferred) {
                void deferred.prompt();
                setDeferred(null);
                dismiss();
              }
            }}
          >
            Add
          </Button>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss"
            className="text-ink-muted hover:text-ink px-1 text-xl leading-none"
          >
            ×
          </button>
        </Card>
      </div>

      {showIosSteps && (
        <IosInstallSheet
          onClose={() => {
            setShowIosSteps(false);
            dismiss();
          }}
        />
      )}
    </>
  );
}

/**
 * iOS has no programmatic install. The only path is Share → Add to Home
 * Screen, so the honest thing is to show exactly where to tap.
 */
function IosInstallSheet({ onClose }: { onClose: () => void }) {
  const steps = [
    { icon: <ShareGlyph />, text: 'Tap the Share button in Safari’s toolbar.' },
    { icon: <PlusGlyph />, text: 'Scroll and choose "Add to Home Screen".' },
    { icon: <span className="text-lg">✓</span>, text: 'Open Domestic from your Home Screen from now on.' },
  ];

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-end md:items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <Card
        className="w-full max-w-sm p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-4">
          <Logo size={36} />
          <h2 className="t-title-lg text-ink">Add to Home Screen</h2>
        </div>

        <ol className="space-y-3">
          {steps.map((step, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="w-8 h-8 rounded-pill bg-sunken grid place-items-center text-ink-2 shrink-0">
                {step.icon}
              </span>
              <span className="t-body-md text-ink pt-1.5">{step.text}</span>
            </li>
          ))}
        </ol>

        <p className="t-body-sm text-ink-muted mt-4">
          iPhone only delivers notifications to apps on your Home Screen — this
          is the one step that makes reminders work.
        </p>

        <Button tone="secondary" full className="mt-4" onClick={onClose}>
          Got it
        </Button>
      </Card>
    </div>
  );
}

function ShareGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v13" />
      <path d="m8 7 4-4 4 4" />
      <path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.75" strokeLinecap="round" aria-hidden>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M12 9v6M9 12h6" />
    </svg>
  );
}

