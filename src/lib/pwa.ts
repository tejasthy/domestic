/** True once the app is running as an installed PWA (Home Screen / standalone
 * window), not just a regular browser tab. iOS exposes this only via
 * `navigator.standalone`; everyone else via the `display-mode` media query. */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}
