import { SiteNav, SiteFooter } from '@/components/site-chrome';

/** Shared shell for /privacy and /terms — one measure, one type ramp. */
export function LegalPage({
  title,
  updated,
  intro,
  children,
}: {
  title: string;
  updated: string;
  intro: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <main className="bg-page">
      <SiteNav />
      <article className="max-w-2xl mx-auto px-6 py-16 md:py-20">
        <h1 className="t-display-xl text-ink">{title}</h1>
        <p className="t-caption text-ink-muted mt-3">Last updated {updated}</p>
        <div className="t-body-lg text-ink-2 mt-6">{intro}</div>
        <div className="mt-10 space-y-9">{children}</div>
      </article>
      <SiteFooter />
    </main>
  );
}

export function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="t-title-lg text-ink mb-3">{heading}</h2>
      <div className="space-y-3 t-body-md text-ink-2 [&_a]:text-accent [&_a]:font-medium [&_strong]:text-ink [&_strong]:font-semibold">
        {children}
      </div>
    </section>
  );
}

export function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-2 pl-5 list-disc marker:text-ink-muted">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
