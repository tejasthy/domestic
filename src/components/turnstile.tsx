'use client';

import Script from 'next/script';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

export type TurnstileHandle = { reset: () => void };

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

/**
 * Cloudflare Turnstile, gating the forms that can create a Supabase account
 * (password sign-up, magic link, password reset) against bots. Renders
 * nothing when no site key is configured — local dev and anyone self-hosting
 * without CAPTCHA set up aren't blocked; Supabase itself only requires a
 * token when captcha protection is turned on for the project.
 */
export const Turnstile = forwardRef<TurnstileHandle, { onVerify: (token: string) => void }>(
  function Turnstile({ onVerify }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const widgetId = useRef<string | null>(null);

    useImperativeHandle(ref, () => ({
      reset() {
        // Tokens are single-use — every retry after a failed submit needs a
        // fresh one, or Supabase rejects it outright.
        if (window.turnstile && widgetId.current) window.turnstile.reset(widgetId.current);
      },
    }));

    function renderWidget() {
      if (!containerRef.current || !window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(containerRef.current, {
        sitekey: SITE_KEY,
        callback: onVerify,
        'expired-callback': () => onVerify(''),
        'error-callback': () => onVerify(''),
      });
    }

    useEffect(() => {
      // <Script>'s onReady only fires for the load that actually fetches the
      // script. A second Turnstile instance on the same page (or a dev-mode
      // Strict Mode remount) finds api.js already cached — window.turnstile
      // exists immediately — and needs its own render() call right away
      // rather than waiting for an onReady that will never come again.
      if (window.turnstile) renderWidget();
      return () => {
        if (window.turnstile && widgetId.current) window.turnstile.remove(widgetId.current);
        widgetId.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!SITE_KEY) return null;

    return (
      <>
        <Script
          src="https://challenges.cloudflare.com/turnstile/v0/api.js"
          strategy="afterInteractive"
          onReady={renderWidget}
        />
        <div ref={containerRef} />
      </>
    );
  },
);
