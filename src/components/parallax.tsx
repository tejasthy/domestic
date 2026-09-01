'use client';

import { useEffect, useRef } from 'react';

/**
 * Scroll-linked translateY, no library. `speed` is relative to normal scroll:
 * 0.4 drifts up slower than the page (background), negative drifts opposite
 * (foreground). Reads scrollY in a rAF loop rather than on every scroll event,
 * and turns itself off for prefers-reduced-motion — the section still renders,
 * it just doesn't move.
 */
export function ParallaxLayer({
  speed,
  className,
  children,
}: {
  speed: number;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let raf = 0;
    function tick() {
      const el = ref.current;
      if (el) {
        const rect = el.parentElement?.getBoundingClientRect();
        const offset = rect ? rect.top * speed : 0;
        el.style.transform = `translate3d(0, ${offset}px, 0)`;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [speed]);

  return (
    <div ref={ref} className={className} aria-hidden>
      {children}
    </div>
  );
}
