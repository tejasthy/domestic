'use client';

import { useEffect } from 'react';

/** Registers the push/offline worker once per load. Silent if unsupported. */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[sw] registration failed', err);
    });
  }, []);

  return null;
}
