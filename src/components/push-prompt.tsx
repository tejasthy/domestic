'use client';

import { useState, useSyncExternalStore, useTransition } from 'react';
import { savePushSubscription, updatePreferences } from '@/lib/actions';
import { subscribeToPush } from '@/lib/push-client';
import { isStandalone } from '@/lib/pwa';
import { Button, Card } from '@/components/ui';
import { Icon } from '@/components/brand';

/** Shown at most once per device — right after it's opened installed for the
 * first time, while permission is still undecided. Settings → Notifications
 * stays the permanent way in for anyone who skips this. */
const PROMPTED_KEY = 'domestic.push.prompted';

function readAlreadyPrompted(): boolean {
  try {
    return localStorage.getItem(PROMPTED_KEY) === '1';
  } catch {
    return false;
  }
}

function markPrompted() {
  try {
    localStorage.setItem(PROMPTED_KEY, '1');
  } catch {
    // Nothing to do — worst case it asks again next open.
  }
}

function readPermission(): NotificationPermission {
  return typeof Notification === 'undefined' ? 'denied' : Notification.permission;
}

export function PushPrompt({ vapidKey }: { vapidKey: string }) {
  const standalone = useSyncExternalStore(() => () => {}, isStandalone, () => false);
  const alreadyPrompted = useSyncExternalStore(() => () => {}, readAlreadyPrompted, () => true);
  const permission = useSyncExternalStore(() => () => {}, readPermission, () => 'denied' as const);
  const [pending, start] = useTransition();
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!standalone || alreadyPrompted || closed || permission !== 'default' || !vapidKey) {
    return null;
  }

  function enable() {
    setError(null);
    markPrompted();
    start(async () => {
      const res = await subscribeToPush(vapidKey);
      if (!res.ok) {
        if (res.reason !== 'permission-denied') setError(res.message ?? 'Could not subscribe.');
        setClosed(true);
        return;
      }
      const saved = await savePushSubscription({
        endpoint: res.endpoint,
        keys: res.keys,
        userAgent: navigator.userAgent,
      });
      if (saved.ok) await updatePreferences({ notify_push: true });
      setClosed(true);
    });
  }

  function skip() {
    markPrompted();
    setClosed(true);
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 pb-safe md:hidden">
      <Card className="p-3.5 shadow-lg flex items-center gap-3">
        <span className="w-9 h-9 grid place-items-center rounded-pill bg-sunken text-ink-2 shrink-0">
          <Icon.Bell size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="t-body-md text-ink font-semibold">Turn on notifications?</p>
          <p className="t-body-sm text-ink-muted">
            Know the moment it&rsquo;s your turn, or someone settles up.
          </p>
          {error && <p className="t-body-sm text-danger mt-1">{error}</p>}
        </div>
        <Button size="sm" disabled={pending} onClick={enable}>
          Turn on
        </Button>
        <button
          type="button"
          onClick={skip}
          disabled={pending}
          aria-label="Not now"
          className="text-ink-muted hover:text-ink px-1 text-xl leading-none disabled:opacity-50"
        >
          ×
        </button>
      </Card>
    </div>
  );
}
