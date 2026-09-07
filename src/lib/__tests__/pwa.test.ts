import { afterEach, describe, expect, it, vi } from 'vitest';
import { isStandalone } from '../pwa';

function stubGlobals(overrides: { matches?: boolean; standalone?: boolean }) {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: query === '(display-mode: standalone)' && (overrides.matches ?? false) }),
  });
  vi.stubGlobal('navigator', { standalone: overrides.standalone });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isStandalone', () => {
  it('is true when the display-mode media query matches (Android/desktop PWA)', () => {
    stubGlobals({ matches: true });
    expect(isStandalone()).toBe(true);
  });

  it('is true when navigator.standalone is set (iOS Home Screen)', () => {
    stubGlobals({ standalone: true });
    expect(isStandalone()).toBe(true);
  });

  it('is false in a plain browser tab', () => {
    stubGlobals({});
    expect(isStandalone()).toBe(false);
  });
});
