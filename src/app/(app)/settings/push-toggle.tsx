'use client';

import { useState, useSyncExternalStore, useTransition } from 'react';
import { savePushSubscription, updatePreferences } from '@/lib/actions';
import { subscribeToPush } from '@/lib/push-client';
import { isStandalone } from '@/lib/pwa';
import { Button, Card } from '@/components/ui';
import { Icon } from '@/components/brand';

type Capability = 'checking' | 'unsupported' | 'needs-install' | 'blocked' | 'available';

function detectCapability(): Capability {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    // iOS only exposes PushManager to home-screen installs, so distinguish
    // "your browser can't" from "you haven't added it to your Home Screen".
    const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
    return iOS && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  return Notification.permission === 'denied' ? 'blocked' : 'available';
}

/** Read once per session — none of these can change without a reload. */
function useCapability(): Capability {
  return useSyncExternalStore(
    () => () => {},
    detectCapability,
    () => 'checking' as const,
  );
}

type State = Capability | 'off' | 'on';

export function PushToggle({
  enabled,
  vapidKey,
  quietFrom,
  quietTo,
}: {
  enabled: boolean;
  vapidKey: string;
  quietFrom: number;
  quietTo: number;
}) {
  const capability = useCapability();
  const [subscribed, setSubscribed] = useState(enabled);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const state: State =
    capability === 'available' ? (subscribed ? 'on' : 'off') : capability;

  async function enable() {
    setError(null);
    const res = await subscribeToPush(vapidKey);
    if (!res.ok) {
      if (res.reason !== 'permission-denied') setError(res.message ?? 'Could not subscribe.');
      return;
    }

    start(async () => {
      const saved = await savePushSubscription({
        endpoint: res.endpoint,
        keys: res.keys,
        userAgent: navigator.userAgent,
      });
      if (!saved.ok) return setError(saved.error);
      await updatePreferences({ notify_push: true });
      setSubscribed(true);
    });
  }

  function disable() {
    start(async () => {
      await updatePreferences({ notify_push: false });
      setSubscribed(false);
    });
  }

  const copy: Record<State, { title: string; body: string }> = {
    checking: { title: 'Checking…', body: '' },
    available: { title: 'Checking…', body: '' },
    unsupported: {
      title: 'Not supported here',
      body: 'This browser cannot do push notifications.',
    },
    'needs-install': {
      title: 'Add Domestic to your Home Screen',
      body: 'iPhone only allows notifications for installed web apps. Share → Add to Home Screen, then open it from there.',
    },
    blocked: {
      title: 'Notifications are blocked',
      body: 'Turn them back on in Settings → Domestic → Notifications.',
    },
    off: {
      title: 'Notifications are off',
      body: "You won't be told when the rotation lands on you.",
    },
    on: {
      title: 'Notifications are on',
      body: `Quiet from ${quietFrom}:00 to ${quietTo}:00.`,
    },
  };

  const { title, body } = copy[state];

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 grid place-items-center rounded-pill bg-sunken text-ink-2 shrink-0">
          <Icon.Bell size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="t-title-md text-ink">{title}</p>
          {body && <p className="t-body-sm text-ink-muted mt-0.5">{body}</p>}
          {error && <p className="t-body-sm text-danger mt-1">{error}</p>}

          {state === 'off' && (
            <Button size="sm" className="mt-3" disabled={pending} onClick={enable}>
              Turn on
            </Button>
          )}
          {state === 'on' && (
            <Button
              size="sm"
              tone="secondary"
              className="mt-3"
              disabled={pending}
              onClick={disable}
            >
              Turn off
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
