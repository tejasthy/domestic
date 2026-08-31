'use client';

import { useState, useTransition } from 'react';
import { markIntroSeen } from '@/lib/actions';
import { Button, Card, cx } from '@/components/ui';
import { Logo } from '@/components/brand';

type Slide = { emoji: string; title: string; body: string };

/**
 * First-run walkthrough. Slides are built from the modules the household
 * actually runs, so nobody is taught a feature their house switched off.
 */
function slidesFor(modules: string[], householdName: string): Slide[] {
  const slides: Slide[] = [
    {
      emoji: '🏠',
      title: `Welcome to ${householdName}`,
      body: 'Domestic keeps track of the boring shared stuff so nobody has to remember whose turn it was.',
    },
  ];

  if (modules.includes('chores')) {
    slides.push(
      {
        emoji: '🔄',
        title: 'Everything runs on a rotation',
        body: 'Each chore cycles through the house in a fixed order. Finish your turn and it moves to the next person automatically — same as crossing your initials off the chart.',
      },
      {
        emoji: '✅',
        title: 'Two kinds of chores',
        body: 'Some are scheduled (floors on Sundays). Others happen whenever — tap "dishwasher is full" and whoever is up gets a nudge.',
      },
    );
  }

  if (modules.includes('expenses')) {
    slides.push({
      emoji: '🧾',
      title: 'Split costs without the spreadsheet',
      body: 'Snap a receipt and the amount fills itself in. Everyone sees what they owe, and settle-up works out the fewest payments that clear the house.',
    });
  }

  slides.push({
    emoji: '🔔',
    title: 'Turn on notifications',
    body: 'You will be told when the rotation lands on you, and nothing else. Quiet hours are on by default overnight.',
  });

  return slides;
}

export function Intro({
  modules,
  householdName,
}: {
  modules: string[];
  householdName: string;
}) {
  const slides = slidesFor(modules, householdName);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  if (done) return null;

  const slide = slides[index];
  const last = index === slides.length - 1;

  function finish() {
    // Close immediately; recording it is not worth making anyone wait.
    setDone(true);
    start(() => markIntroSeen().then(() => {}));
  }

  return (
    <div className="fixed inset-0 z-[70] bg-page flex flex-col">
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center max-w-md mx-auto w-full">
        {index === 0 && <Logo size={44} className="mb-6" />}
        <div className="text-6xl mb-6" aria-hidden>{slide.emoji}</div>
        <h2 className="t-display-lg text-ink">{slide.title}</h2>
        <p className="t-body-lg text-ink-2 mt-3">{slide.body}</p>
      </div>

      <div className="px-6 pb-safe max-w-md mx-auto w-full">
        <div className="flex justify-center gap-1.5 mb-5" aria-hidden>
          {slides.map((_, i) => (
            <span
              key={i}
              className={cx(
                'h-1.5 rounded-pill transition-all duration-[180ms]',
                i === index ? 'w-6 bg-blue dark:bg-maize' : 'w-1.5 bg-line',
              )}
            />
          ))}
        </div>

        <Button
          size="lg"
          full
          disabled={pending}
          onClick={() => (last ? finish() : setIndex((i) => i + 1))}
        >
          {last ? 'Get started' : 'Next'}
        </Button>

        {!last && (
          <button
            type="button"
            onClick={finish}
            className="w-full t-body-sm text-ink-muted hover:text-ink py-3 transition-colors"
          >
            Skip
          </button>
        )}
        {last && <div className="h-12" />}
      </div>
    </div>
  );
}

/** Re-runnable from settings, for anyone who skipped it. */
export function ReplayIntro({
  modules,
  householdName,
}: {
  modules: string[];
  householdName: string;
}) {
  const [open, setOpen] = useState(false);
  if (open) return <Intro modules={modules} householdName={householdName} />;
  return (
    <Card className="p-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left"
      >
        <p className="t-title-md text-ink">How Domestic works</p>
        <p className="t-body-sm text-ink-muted mt-0.5">
          Replay the walkthrough.
        </p>
      </button>
    </Card>
  );
}
