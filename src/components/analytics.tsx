import Script from 'next/script';

const GA_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

/** No-op until NEXT_PUBLIC_GA_MEASUREMENT_ID is set — same env-gated pattern
 * as magic links and the Turnstile widget, so a fresh deploy with nothing
 * configured just doesn't load Google's script at all. */
export function Analytics() {
  if (!GA_ID) return null;

  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
      <Script id="ga-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_ID}');
        `}
      </Script>
    </>
  );
}
