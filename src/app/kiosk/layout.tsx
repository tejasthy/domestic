import type { Metadata } from 'next';

// Overrides the root manifest so "Add to Home Screen" from /kiosk installs an
// icon whose start_url is /kiosk, not / — the dashboard, which requires a
// login session the kiosk device doesn't have.
export const metadata: Metadata = {
  title: 'Domestic Kiosk',
  manifest: '/kiosk-manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Domestic Kiosk',
    statusBarStyle: 'default',
  },
};

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return children;
}
