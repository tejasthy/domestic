import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/data';
import { Card, Initials, Pill, LinkButton } from '@/components/ui';
import { SiteNav, SiteFooter } from '@/components/site-chrome';
import { ParallaxLayer, Reveal } from '@/components/parallax';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Domestic — chores and shared costs, split fairly',
  description:
    'The fridge chart and the group-chat IOUs, digitized. A fixed chore rotation and remainder-safe expense splitting for any house.',
};

const DEMO_PEOPLE = [
  { name: 'Sam', initials: 'SM', color: '#2f65a7' },
  { name: 'Priya', initials: 'PR', color: '#9a3324' },
  { name: 'Jordan', initials: 'JD', color: '#75988d' },
  { name: 'Alex', initials: 'AX', color: '#702082' },
];

export default async function MarketingPage() {
  // Already have a house — the marketing pitch isn't for you, the app is.
  const session = await getSession();
  if (session?.me && session.household) redirect('/home');
  if (session?.me) redirect('/onboarding');

  return (
    <main data-smooth-scroll className="bg-page overflow-x-clip">
      <SiteNav />
      <Hero />
      <Story />
      <ChoresFeature />
      <ExpensesFeature />
      <KioskFeature />
      <HowItWorks />
      <FinalCta />
      <SiteFooter />
    </main>
  );
}

/* -------------------------------------------------------------------- hero */

function Blob({ className }: { className: string }) {
  return <div className={`absolute rounded-full blur-3xl ${className}`} />;
}

function Hero() {
  return (
    <section className="relative overflow-hidden px-6 pt-16 pb-24 md:pt-24 md:pb-32">
      <ParallaxLayer decorative speed={0.15} className="absolute inset-0 pointer-events-none">
        <Blob className="w-[28rem] h-[28rem] bg-maize/25 -top-24 -right-24" />
      </ParallaxLayer>
      <ParallaxLayer decorative speed={0.28} className="absolute inset-0 pointer-events-none">
        <Blob className="w-72 h-72 bg-blue/10 dark:bg-maize/10 top-40 -left-16" />
      </ParallaxLayer>

      <div className="relative max-w-3xl mx-auto text-center">
        <p className="t-label text-accent mb-4">Chores + shared costs, one app</p>
        <h1 className="t-display-xl text-ink">
          The fridge chart, <br className="hidden sm:block" />
          minus the guesswork.
        </h1>
        <p className="t-body-lg text-ink-2 mt-5 max-w-xl mx-auto">
          A fixed chore rotation nobody can quietly reassign, and expense
          splits that settle to the cent — for a household of any size,
          not just ours.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-8">
          <LinkButton href="/login" size="xl">
            Start your house
          </LinkButton>
          <a
            href="#story"
            className="t-body-md font-semibold text-ink-2 hover:text-ink transition-colors px-2 py-3"
          >
            The story behind the app ↓
          </a>
        </div>
      </div>

      <div className="relative max-w-md mx-auto mt-16">
        <ParallaxLayer speed={-0.08}>
          <ChoresMockup />
        </ParallaxLayer>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- story */

function Story() {
  return (
    <section
      id="story"
      // Clears the sticky nav (h-14) when the hero's anchor scrolls here.
      className="relative scroll-mt-14 overflow-hidden px-6 py-24 md:py-32 bg-sunken"
    >
      <ParallaxLayer decorative speed={0.2} className="absolute inset-0 pointer-events-none">
        <Blob className="w-[30rem] h-[30rem] bg-maize/20 -top-40 -left-32" />
      </ParallaxLayer>
      <ParallaxLayer decorative speed={-0.12} className="absolute inset-0 pointer-events-none">
        <Blob className="w-80 h-80 bg-blue/5 dark:bg-maize/5 -bottom-24 -right-16" />
      </ParallaxLayer>

      <div className="relative max-w-2xl mx-auto">
        <Reveal>
          <h2 className="t-display-xl text-ink">Brandon was a bum.</h2>
        </Reveal>

        <Reveal delay={120} className="mt-8">
          <div className="border-l-4 border-maize pl-6 space-y-5">
            <p className="t-title-lg text-ink">
              I live with 4 roommates. For years, the chore rotation was a
              paper chart taped to the fridge, and the money was a Google
              Sheet that required manual categorization and itemization of
              receipts and expenses.
            </p>
            <p className="t-body-lg text-ink-2">
              As we started senior year, the printer stopped working. Being
              too lazy to buy printer ink, I built a digital version. A chore
              rotation that allows easy tracking, and a ledger that always
              adds up with AI-enabled receipt scanning.
            </p>
            <p className="t-body-lg text-ink-2">
              I built it for my own house first. It&rsquo;s free and it&rsquo;s
              now open for your household.
            </p>
            <p className="t-label text-ink-muted">— Tejas</p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- features */

function FeatureSection({
  eyebrow,
  title,
  body,
  reverse,
  mockup,
}: {
  eyebrow: string;
  title: string;
  body: string;
  reverse?: boolean;
  mockup: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden px-6 py-20 md:py-28">
      <ParallaxLayer decorative speed={0.14} className="absolute inset-0 pointer-events-none">
        <Blob
          className={`w-80 h-80 bg-blue/5 dark:bg-maize/5 top-1/4 ${
            reverse ? '-left-32' : '-right-32'
          }`}
        />
      </ParallaxLayer>

      <div
        className={`relative max-w-5xl mx-auto grid md:grid-cols-2 gap-10 md:gap-16 items-center ${
          reverse ? 'md:[&>*:first-child]:order-2' : ''
        }`}
      >
        <Reveal>
          <p className="t-label text-accent mb-3">{eyebrow}</p>
          <h2 className="t-display-lg text-ink">{title}</h2>
          <p className="t-body-lg text-ink-2 mt-4">{body}</p>
        </Reveal>
        {/* The card drifts against the page, so it slides past the copy
            beside it instead of riding along with it. */}
        <ParallaxLayer speed={-0.07}>{mockup}</ParallaxLayer>
      </div>
    </section>
  );
}

function ChoresFeature() {
  return (
    <FeatureSection
      eyebrow="Chores"
      title="A rotation nobody can quietly mess with."
      body="Every chore owns a fixed order and a turn counter — turn N always belongs to the same person in the cycle. Finish it and the baton moves. Swap, skip, or go away for a while, and the order still stays exactly as predictable as the printed sheet."
      mockup={<ChoresMockup />}
    />
  );
}

function ExpensesFeature() {
  return (
    <FeatureSection
      eyebrow="Shared costs"
      reverse
      title="Split to the cent, settle in the fewest payments."
      body="Snap a receipt and let it fill in the line items. Split evenly, by exact amount, or by share — the math is remainder-safe, so it always adds back up to the total. When it's time to pay, Domestic works out the smallest set of transfers that clears the whole house."
      mockup={<ExpensesMockup />}
    />
  );
}

function KioskFeature() {
  return (
    <FeatureSection
      eyebrow="Wall display"
      title="A board for the kitchen, not just your phone."
      body="Pair a spare tablet and it becomes an always-on kiosk — today's chores, who's up, and notes the house leaves each other. No login on the tablet itself, so anyone walking by the kitchen can glance and go."
      mockup={<KioskMockup />}
    />
  );
}

/* -------------------------------------------------------------- mockups */

function ChoresMockup() {
  const rows = [
    { emoji: '🧹', name: 'Floors', person: DEMO_PEOPLE[0], status: 'Due today' },
    { emoji: '🍽️', name: 'Dishes', person: DEMO_PEOPLE[1], status: 'Up next' },
    { emoji: '🗑️', name: 'Trash', person: DEMO_PEOPLE[2], status: 'Done' },
  ];
  return (
    <Card className="p-4">
      <p className="t-label text-ink-muted mb-3">Today</p>
      <div className="divide-y divide-[var(--border-subtle)]">
        {rows.map((r) => (
          <div key={r.name} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <span className="text-xl" aria-hidden>{r.emoji}</span>
            <div className="min-w-0 flex-1">
              <p className="t-body-md text-ink">{r.name}</p>
              <p className="t-body-sm text-ink-muted">{r.person.name}</p>
            </div>
            <Initials initials={r.person.initials} color={r.person.color} size="sm" />
            <Pill tone={r.status === 'Done' ? 'success' : r.status === 'Due today' ? 'accent' : 'neutral'}>
              {r.status}
            </Pill>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ExpensesMockup() {
  const rows = [
    { desc: 'Costco run', by: DEMO_PEOPLE[2], amount: '$86.40', share: '$21.60' },
    { desc: 'Internet — March', by: DEMO_PEOPLE[3], amount: '$64.00', share: '$16.00' },
  ];
  return (
    <Card className="p-4">
      <p className="t-label text-ink-muted mb-3">Shared costs</p>
      <div className="divide-y divide-[var(--border-subtle)]">
        {rows.map((r) => (
          <div key={r.desc} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <Initials initials={r.by.initials} color={r.by.color} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="t-body-md text-ink">{r.desc}</p>
              <p className="t-body-sm text-ink-muted">{r.by.name} paid {r.amount}</p>
            </div>
            <p className="t-body-md font-semibold text-ink">{r.share}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-subtle">
        <p className="t-body-sm text-ink-muted">Settle up in</p>
        <Pill tone="info">2 payments</Pill>
      </div>
    </Card>
  );
}

function KioskMockup() {
  return (
    <Card className="p-5 bg-inverse border-transparent">
      <p className="t-label text-ink-inverse/70 mb-3">The Maple House</p>
      <div className="space-y-3">
        {DEMO_PEOPLE.slice(0, 2).map((p, i) => (
          <div key={p.name} className="flex items-center gap-3">
            <Initials initials={p.initials} color={p.color} size="md" />
            <p className="t-title-md text-ink-inverse">
              {i === 0 ? 'Floors — due today' : 'Dishes — up next'}
            </p>
          </div>
        ))}
      </div>
      <p className="t-body-sm text-ink-inverse/60 mt-4">72° and clear · updated just now</p>
    </Card>
  );
}

/* ---------------------------------------------------------------- how-to */

function HowItWorks() {
  const steps = [
    {
      n: '1',
      title: 'Start your house',
      body: 'Name it, pick which parts you want — chores, shared costs, wall display — and you’re the admin.',
    },
    {
      n: '2',
      title: 'Invite your roommates',
      body: 'Settings makes a code and a ready-to-share link. Whoever uses it lands right in your house.',
    },
    {
      n: '3',
      title: 'Everyone signs in',
      body: 'Google or email. No roster to maintain by hand, no spreadsheet to keep syncing.',
    },
  ];
  return (
    <section className="relative overflow-hidden px-6 py-16 md:py-20 bg-sunken">
      <ParallaxLayer decorative speed={0.16} className="absolute inset-0 pointer-events-none">
        <Blob className="w-96 h-96 bg-maize/15 top-0 left-1/2 -translate-x-1/2" />
      </ParallaxLayer>

      <div className="relative max-w-5xl mx-auto">
        <Reveal>
          <p className="t-label text-accent mb-3 text-center">How it works</p>
          <h2 className="t-display-lg text-ink text-center mb-12">Up and running in a few minutes.</h2>
        </Reveal>
        <div className="grid sm:grid-cols-3 gap-6">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 110}>
              <div className="w-10 h-10 rounded-pill bg-blue text-white dark:bg-maize dark:text-blue flex items-center justify-center t-title-md font-display mb-4">
                {s.n}
              </div>
              <h3 className="t-title-lg text-ink">{s.title}</h3>
              <p className="t-body-md text-ink-2 mt-2">{s.body}</p>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- final */

function FinalCta() {
  return (
    <section className="relative px-6 py-20 md:py-28 bg-blue overflow-hidden">
      <ParallaxLayer decorative speed={0.12} className="absolute inset-0 pointer-events-none">
        <Blob className="w-96 h-96 bg-maize/20 -bottom-32 -left-20" />
      </ParallaxLayer>
      <ParallaxLayer decorative speed={-0.18} className="absolute inset-0 pointer-events-none">
        <Blob className="w-72 h-72 bg-white/10 -top-24 -right-16" />
      </ParallaxLayer>
      <Reveal className="relative max-w-2xl mx-auto text-center">
        <h2 className="t-display-lg text-white">Ready to ditch the spreadsheet?</h2>
        <p className="t-body-lg text-white/80 mt-4">
          Free to run, remainder-safe by design, and it fits your house — not just mine.
        </p>
        <div className="mt-8">
          {/* This band stays blue in both themes, so the button can't ride
              the usual secondary-tone dark: swap — it would blend right in. */}
          <LinkButton
            href="/login"
            size="xl"
            tone="secondary"
            className="!bg-white !text-blue !border-transparent hover:!bg-white/90"
          >
            Start your house
          </LinkButton>
        </div>
      </Reveal>
    </section>
  );
}
