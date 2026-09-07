import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeToPush } from '../push-client';

function stubNotification(permission: NotificationPermission) {
  vi.stubGlobal('Notification', {
    requestPermission: vi.fn().mockResolvedValue(permission),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeToPush', () => {
  it('refuses without a VAPID key, without ever prompting for permission', async () => {
    stubNotification('default');
    const res = await subscribeToPush('');
    expect(res).toEqual({ ok: false, reason: 'no-vapid', message: expect.any(String) });
    expect((globalThis as unknown as { Notification: { requestPermission: () => void } }).Notification.requestPermission)
      .not.toHaveBeenCalled();
  });

  it('reports permission-denied without touching the service worker', async () => {
    stubNotification('denied');
    const res = await subscribeToPush('some-key');
    expect(res).toEqual({ ok: false, reason: 'permission-denied' });
  });

  it('subscribes and returns the endpoint/keys on success', async () => {
    stubNotification('granted');
    vi.stubGlobal('atob', (s: string) => Buffer.from(s, 'base64').toString('binary'));
    const toJSON = () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { subscribe: vi.fn().mockResolvedValue({ toJSON }) },
        }),
      },
    });

    const res = await subscribeToPush('AAAA');
    expect(res).toEqual({ ok: true, endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } });
  });

  it('reports subscribe-failed when pushManager.subscribe throws', async () => {
    stubNotification('granted');
    vi.stubGlobal('atob', (s: string) => Buffer.from(s, 'base64').toString('binary'));
    vi.stubGlobal('navigator', {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: { subscribe: vi.fn().mockRejectedValue(new Error('nope')) },
        }),
      },
    });

    const res = await subscribeToPush('AAAA');
    expect(res).toEqual({ ok: false, reason: 'subscribe-failed', message: 'nope' });
  });
});
