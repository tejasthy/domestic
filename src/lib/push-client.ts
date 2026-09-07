/** VAPID keys travel as base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64: string) {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const normal = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normal);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export type PushSubscribeResult =
  | { ok: true; endpoint: string; keys: { p256dh: string; auth: string } }
  | { ok: false; reason: 'no-vapid' | 'permission-denied' | 'subscribe-failed'; message?: string };

/** Asks for notification permission and subscribes this device — the part
 * shared between the permanent Settings toggle and the post-install prompt. */
export async function subscribeToPush(vapidKey: string): Promise<PushSubscribeResult> {
  if (!vapidKey) {
    return { ok: false, reason: 'no-vapid', message: 'Push keys are not configured on the server yet.' };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, reason: 'permission-denied' };

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    return { ok: true, endpoint: json.endpoint, keys: json.keys };
  } catch (err) {
    return {
      ok: false,
      reason: 'subscribe-failed',
      message: err instanceof Error ? err.message : 'Could not subscribe.',
    };
  }
}
