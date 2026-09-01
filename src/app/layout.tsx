import type { Metadata, Viewport } from 'next';
import { Oswald, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google';
import { cookies } from 'next/headers';
import { THEME_COOKIE, parseThemeCookie } from '@/lib/theme';
import { Analytics } from '@/components/analytics';
import './globals.css';

const oswald = Oswald({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-oswald',
});

const plexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  title: 'Domestic',
  description: 'Chores and shared costs for your house, sorted.',
  manifest: '/manifest.webmanifest',
  icons: { apple: '/icons/apple-touch-icon.png' },
  appleWebApp: {
    capable: true,
    title: 'Domestic',
    // 'default' paints the iOS status bar white regardless of app theme;
    // 'black-translucent' lets the page's own background show through.
    statusBarStyle: 'black-translucent',
  },
};

const SURFACE_LIGHT = '#f7f8f9';
const SURFACE_DARK = '#0e1116';

export async function generateViewport(): Promise<Viewport> {
  const theme = parseThemeCookie((await cookies()).get(THEME_COOKIE)?.value);

  return {
    // The in-app theme toggle can disagree with the OS scheme, so a
    // resolved light/dark cookie pins theme-color to match instead of
    // leaving it keyed to prefers-color-scheme alone.
    themeColor:
      theme === 'system'
        ? [
            { media: '(prefers-color-scheme: light)', color: SURFACE_LIGHT },
            { media: '(prefers-color-scheme: dark)', color: SURFACE_DARK },
          ]
        : theme === 'dark'
          ? SURFACE_DARK
          : SURFACE_LIGHT,
    width: 'device-width',
    initialScale: 1,
    viewportFit: 'cover',
    // The kiosk and phone are both fixed-layout; pinch-zoom only causes misfires.
    maximumScale: 1,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = parseThemeCookie((await cookies()).get(THEME_COOKIE)?.value);

  return (
    <html
      lang="en"
      className={`${oswald.variable} ${plexSans.variable} ${plexMono.variable}`}
      data-theme={theme === 'system' ? undefined : theme}
    >
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
