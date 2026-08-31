export type ThemeMode = 'system' | 'light' | 'dark';

export const THEME_COOKIE = 'theme';

export function parseThemeCookie(value: string | undefined): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system';
}
