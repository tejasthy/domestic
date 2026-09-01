'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';

/* ------------------------------------------------------------------ driver */

type Layer = { el: HTMLElement; speed: number };

// One rAF loop for the whole page. Each ParallaxLayer registering its own
// loop was fine at two layers; the marketing page now runs a dozen.
const layers = new Set<Layer>();
let raf = 0;

function tick() {
  const vh = window.innerHeight;
  for (const layer of layers) {
    const host = layer.el.parentElement ?? layer.el;
    const rect = host.getBoundingClientRect();
    // Measured from the element's own centre, so drift is zero when it sits
    // mid-viewport — a layer never starts life shoved far off its layout spot.
    const from = rect.top + rect.height / 2 - vh / 2;
    layer.el.style.transform = `translate3d(0, ${(from * layer.speed).toFixed(2)}px, 0)`;
  }
  raf = layers.size > 0 ? requestAnimationFrame(tick) : 0;
}

function register(layer: Layer) {
  layers.add(layer);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => {
    layers.delete(layer);
    if (layers.size === 0 && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* ------------------------------------------------------------------ layers */

/**
 * Scroll-linked translateY, no library. `speed` is relative to normal scroll:
 * positive drifts with the page (background), negative drifts against it
 * (foreground). Reads scrollY in a shared rAF loop rather than on every scroll
 * event, and turns itself off for prefers-reduced-motion — the section still
 * renders, it just doesn't move.
 *
 * `decorative` hides the layer from assistive tech; use it for the blobs, not
 * for layers that carry real content.
 */
export function ParallaxLayer({
  speed,
  className,
  decorative,
  children,
}: {
  speed: number;
  className?: string;
  decorative?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    return register({ el, speed });
  }, [speed]);

  return (
    <div ref={ref} className={className} aria-hidden={decorative || undefined}>
      {children}
    </div>
  );
}

/**
 * Fade-and-rise as the element scrolls into view, once. Starts in the plain
 * laid-out state and only arms itself in a layout effect, so the copy is still
 * there with JS off or before hydration — and reduced-motion skips it entirely.
 */
export function Reveal({
  delay = 0,
  className,
  children,
}: {
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;

    // Armed imperatively rather than through state, so the markup that ships
    // from the server is the plain laid-out one — the copy is still there
    // before hydration, or with JS off entirely.
    el.style.opacity = '0';
    el.style.transform = 'translate3d(0, 18px, 0)';
    el.style.transition =
      `opacity 700ms ease ${delay}ms,` +
      ` transform 700ms cubic-bezier(0.22, 0.7, 0.3, 1) ${delay}ms`;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        el.style.opacity = '1';
        el.style.transform = 'none';
        io.disconnect();
      },
      { rootMargin: '0px 0px -10% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delay]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
