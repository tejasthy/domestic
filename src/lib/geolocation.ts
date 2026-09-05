'use client';

export type GeoResult =
  | { ok: true; lat: number; lon: number }
  | { ok: false; reason: 'unsupported' | 'denied' | 'timeout' | 'unavailable' };

/**
 * Only called when a household has geofencing on — see TurnRow in
 * turn-card.tsx. `enableHighAccuracy: false` on purpose: the default 150m
 * radius doesn't need GPS-chip precision, and low-accuracy mode resolves
 * faster and cheaper on battery. `maximumAge` allows a just-taken fix to be
 * reused instead of forcing a fresh one on every tap.
 */
export function getCurrentPosition(timeoutMs = 8000): Promise<GeoResult> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve({ ok: false, reason: 'unsupported' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ ok: true, lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) =>
        resolve({
          ok: false,
          reason:
            err.code === err.PERMISSION_DENIED
              ? 'denied'
              : err.code === err.TIMEOUT
                ? 'timeout'
                : 'unavailable',
        }),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 30000 },
    );
  });
}
