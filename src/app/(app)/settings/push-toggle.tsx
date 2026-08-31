'use client';

import { useState, useSyncExternalStore, useTransition } from 'react';
import { savePushSubscription, updatePreferences } from '@/lib/actions';
import { Button, Card } from '@/components/ui';
import { Icon } from '@/components/brand';

/** VAPID keys travel as base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64: string) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const normal = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normal);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

type Capability = 'checking' | 'unsupported' | 'needs-install' | 'blocked' | 'available';

function detectCapability(): Capability {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    // iOS only exposes PushManager to home-screen installs, so distinguish
    // "your browser can't" from "you haven't added it to your Home Screen".
    const iOS = /iP(hone|ad|od)/.test(navigator.userAgent);
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    return iOS && !standalone ? 'needs-install' : 'unsupported';
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
    if (!vapidKey) {
      setError('Push keys are not configured on the server yet.');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
      const json = sub.toJSON() as {
        endpoint: string;
        keys: { p256dh: string; auth: string };
      };

      start(async () => {
        const saved = await savePushSubscription({
          endpoint: json.endpoint,
          keys: json.keys,
          userAgent: navigator.userAgent,
        });
        if (!saved.ok) return setError(saved.error);
        await updatePreferences({ notify_push: true });
        setSubscribed(true);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not subscribe.');
    }
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
