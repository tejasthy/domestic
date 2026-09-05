'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createChore, updateChore, setChoreActive, type ChoreInputType } from '@/lib/chore-actions';
import { Button, Card, Field, Initials, Input, Select, cx } from '@/components/ui';
import type { Chore, ChoreCadence, Profile } from '@/lib/types';

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function formatHour(h: number) {
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:00 ${period}`;
}

function moveInList(ids: string[], index: number, dir: -1 | 1): string[] {
  const target = index + dir;
  if (target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

type ChoreFormProps =
  | { mode: 'create'; members: Profile[] }
  | { mode: 'edit'; members: Profile[]; chore: Chore; initialRotation: string[] };

export function ChoreForm(props: ChoreFormProps) {
  const { mode, members } = props;
  const chore = props.mode === 'edit' ? props.chore : undefined;

  const router = useRouter();
  const [pending, startSubmit] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(chore?.name ?? '');
  const [emoji, setEmoji] = useState(chore?.emoji ?? '🧹');
  const [description, setDescription] = useState(chore?.description ?? '');
  const [cadence, setCadence] = useState<ChoreCadence>(chore?.cadence ?? 'scheduled');
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(chore?.days_of_week ?? []);
  const [intervalWeeks, setIntervalWeeks] = useState(chore?.interval_weeks ?? 1);
  const [dueHour, setDueHour] = useState(chore?.due_hour ?? 20);
  const [queueDepth, setQueueDepth] = useState(chore?.queue_depth ?? 4);
  const [lookaheadDays, setLookaheadDays] = useState(chore?.lookahead_days ?? 21);
  const [rotation, setRotation] = useState<string[]>(
    props.mode === 'edit' ? props.initialRotation : members.map((m) => m.id),
  );

  function toggleDay(day: number) {
    setDaysOfWeek((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day],
    );
  }

  function toggleMember(id: string) {
    setRotation((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const input: ChoreInputType = {
      name,
      emoji,
      description: description || undefined,
      cadence,
      days_of_week: cadence === 'scheduled' ? daysOfWeek : [],
      interval_weeks: intervalWeeks,
      due_hour: dueHour,
      queue_depth: cadence === 'standing' ? 1 : queueDepth,
      lookahead_days: lookaheadDays,
      profile_ids: rotation,
    };

    startSubmit(async () => {
      const res = mode === 'create'
        ? await createChore(input)
        : await updateChore(chore!.id, input);

      if (res.ok) router.push('/chores/manage');
      else setError(res.error);
    });
  }

  // Included members first, in turn order, then everyone not yet added.
  const rows = [
    ...rotation.map((id) => members.find((m) => m.id === id)).filter((m): m is Profile => Boolean(m)),
    ...members.filter((m) => !rotation.includes(m.id)),
  ];

  return (
    <div className="space-y-5">
      <form onSubmit={onSubmit} className="space-y-5">
        <div className="flex gap-3">
          <Field label="Emoji" className="w-20 shrink-0">
            <Input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              maxLength={8}
              className="text-center text-lg"
            />
          </Field>
          <Field label="Name" className="flex-1">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Take out trash"
              required
              maxLength={80}
            />
          </Field>
        </div>

        <Field label="Description (optional)">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Whatever's helpful to know"
            maxLength={300}
          />
        </Field>

        <div>
          <span className="t-label text-ink-muted block mb-1.5">Cadence</span>
          <div className="flex gap-2">
            {(['scheduled', 'on_demand', 'standing'] as const).map((c) => {
              const on = cadence === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCadence(c)}
                  aria-pressed={on}
                  className={cx(
                    'flex-1 h-11 rounded-md border font-medium text-[14px] transition-colors duration-[120ms]',
                    on
                      ? 'border-maize bg-maize/12 text-ink'
                      : 'border-subtle bg-card opacity-60 hover:opacity-100 text-ink-2',
                  )}
                >
                  {c === 'scheduled' ? 'Scheduled' : c === 'on_demand' ? 'On demand' : 'Standing'}
                </button>
              );
            })}
          </div>
        </div>

        {cadence === 'standing' ? (
          <p className="t-body-sm text-ink-muted">
            Whoever&rsquo;s up does it, then it instantly passes to the next
            person. No due date, no queue — it&rsquo;s just always someone&rsquo;s job.
          </p>
        ) : cadence === 'scheduled' ? (
          <>
            <div>
              <span className="t-label text-ink-muted block mb-1.5">Days</span>
              <div className="flex gap-1.5">
                {DAY_LABELS.map((label, i) => {
                  const on = daysOfWeek.includes(i);
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => toggleDay(i)}
                      aria-pressed={on}
                      className={cx(
                        'w-9 h-9 rounded-md border text-[13px] font-semibold transition-colors duration-[120ms]',
                        on
                          ? 'border-maize bg-maize/12 text-ink'
                          : 'border-subtle bg-card opacity-60 hover:opacity-100 text-ink-2',
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Repeats">
                <Select
                  value={String(intervalWeeks)}
                  onChange={(e) => setIntervalWeeks(Number(e.target.value))}
                >
                  <option value="1">Every week</option>
                  <option value="2">Every other week</option>
                  <option value="3">Every 3 weeks</option>
                  <option value="4">Every 4 weeks</option>
                </Select>
              </Field>
              <Field label="Due by">
                <Select
                  value={String(dueHour)}
                  onChange={(e) => setDueHour(Number(e.target.value))}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{formatHour(h)}</option>
                  ))}
                </Select>
              </Field>
            </div>

            <Field label="Materialize turns" hint="How far ahead to schedule turns on the chart.">
              <Select
                value={String(lookaheadDays)}
                onChange={(e) => setLookaheadDays(Number(e.target.value))}
              >
                <option value="7">1 week ahead</option>
                <option value="14">2 weeks ahead</option>
                <option value="21">3 weeks ahead</option>
                <option value="30">30 days ahead</option>
              </Select>
            </Field>
          </>
        ) : (
          <Field label="Queue depth" hint="How many turns stay pending at once.">
            <Input
              type="number"
              min={1}
              max={20}
              value={queueDepth}
              onChange={(e) => setQueueDepth(Number(e.target.value))}
            />
          </Field>
        )}

        <div>
          <span className="t-label text-ink-muted block mb-2">Rotation</span>
          <div className="space-y-2">
            {rows.map((m) => {
              const idx = rotation.indexOf(m.id);
              const on = idx !== -1;
              return (
                <div key={m.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => toggleMember(m.id)}
                    aria-pressed={on}
                    className={cx(
                      'flex-1 flex items-center gap-3 p-3 rounded-md border text-left',
                      'transition-colors duration-[120ms]',
                      on
                        ? 'border-maize bg-maize/12'
                        : 'border-subtle bg-card opacity-60 hover:opacity-100',
                    )}
                  >
                    <Initials initials={m.initials} color={m.color} size="md" dim={!on} />
                    <span className="t-body-md text-ink flex-1">{m.full_name}</span>
                  </button>
                  {on && (
                    <div className="flex flex-col gap-1">
                      <Button
                        type="button"
                        size="sm"
                        tone="ghost"
                        disabled={idx === 0}
                        onClick={() => setRotation((prev) => moveInList(prev, idx, -1))}
                      >
                        ↑
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        tone="ghost"
                        disabled={idx === rotation.length - 1}
                        onClick={() => setRotation((prev) => moveInList(prev, idx, 1))}
                      >
                        ↓
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {error && (
          <p className="t-body-sm text-danger bg-danger/10 border border-danger/25 rounded-md px-3 py-2">
            {error}
          </p>
        )}

        <Button type="submit" size="lg" full disabled={pending || name.trim().length === 0}>
          {pending
            ? 'Saving…'
            : mode === 'create' ? 'Add chore' : 'Save changes'}
        </Button>
      </form>

      {mode === 'edit' && chore && <DeactivateControl chore={chore} />}
    </div>
  );
}

function DeactivateControl({ chore }: { chore: Chore }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!chore.is_active) {
    return (
      <Card className="p-4">
        <p className="t-body-sm text-ink-muted mb-3">
          {chore.name} is off — nobody is up for it and no new turns are being made.
        </p>
        <Button
          type="button"
          tone="secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await setChoreActive(chore.id, true);
              if (!res.ok) setError(res.error);
            })
          }
        >
          {pending ? 'Reactivating…' : 'Reactivate'}
        </Button>
        {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
      </Card>
    );
  }

  return (
    <Card className="p-4">
      {confirming ? (
        <Button
          type="button"
          tone="danger"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await setChoreActive(chore.id, false);
              if (!res.ok) setError(res.error);
              setConfirming(false);
            })
          }
        >
          Really deactivate
        </Button>
      ) : (
        <Button type="button" tone="secondary" onClick={() => setConfirming(true)}>
          Deactivate
        </Button>
      )}
      {confirming && (
        <p className="t-body-sm text-ink-muted mt-2">
          Turns already on the chart stay as they are; nobody new gets added to{' '}
          {chore.name} until you reactivate it.
        </p>
      )}
      {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
    </Card>
  );
}
