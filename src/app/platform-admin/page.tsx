import { getPlatformStats, getPlatformHouseholdsSummary, getPlatformFeedback } from '@/lib/data';
import { Card, SectionHeader, Pill } from '@/components/ui';
import { formatInTimeZone } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="p-4">
      <p className="t-label text-ink-muted">{label}</p>
      <p className="t-display-lg text-ink mt-1">{value}</p>
    </Card>
  );
}

export default async function PlatformAdminPage() {
  const [stats, households, feedback] = await Promise.all([
    getPlatformStats(),
    getPlatformHouseholdsSummary(),
    getPlatformFeedback(),
  ]);

  if (!stats) {
    return <p className="t-body-md text-ink">Could not load platform stats.</p>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <header>
        <h1 className="t-display-lg text-ink">Platform admin</h1>
        <p className="t-body-md text-ink-muted mt-1">
          Scaffolding for future multi-household deployments. With one real
          household today, these numbers are expected to look trivial —
          that&rsquo;s not a bug.
        </p>
      </header>

      <section>
        <SectionHeader title="Households & members" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Tile label="Households" value={stats.households_total} />
          <Tile label="Households, 30d" value={stats.households_last_30d} />
          <Tile label="Members" value={stats.members_total} />
          <Tile label="Members, 30d" value={stats.members_last_30d} />
          <Tile label="Admins" value={stats.admins_total} />
        </div>
      </section>

      <section>
        <SectionHeader title="Module adoption" />
        <Card className="p-4 flex flex-wrap gap-2">
          {Object.entries(stats.module_enabled_counts).length === 0 ? (
            <p className="t-body-sm text-ink-muted">No modules enabled anywhere yet.</p>
          ) : (
            Object.entries(stats.module_enabled_counts).map(([module, count]) => (
              <Pill key={module} tone="info">{module}: {count}</Pill>
            ))
          )}
        </Card>
      </section>

      <section>
        <SectionHeader title="Chore engagement" />
        <div className="grid grid-cols-3 gap-3">
          <Tile label="Done, 7d" value={stats.turns_completed_last_7d} />
          <Tile label="Done, 30d" value={stats.turns_completed_last_30d} />
          <Tile label="Skipped, 30d" value={stats.turns_skipped_last_30d} />
        </div>
      </section>

      <section>
        <SectionHeader title="Permissions posture" />
        <div className="grid grid-cols-2 gap-3">
          <Tile label="Cross-complete on" value={stats.cross_complete_enabled_count} />
          <Tile label="Geofence on" value={stats.geofence_enabled_count} />
        </div>
      </section>

      <section>
        <SectionHeader title="Signup source" />
        <Card className="p-4 flex flex-wrap gap-2">
          {Object.entries(stats.signup_source_counts).map(([source, count]) => (
            <Pill key={source} tone="neutral">{source}: {count}</Pill>
          ))}
        </Card>
      </section>

      <section>
        <SectionHeader title="Households" />
        <Card className="divide-y divide-[var(--border-subtle)]">
          {households.map((h) => (
            <div key={h.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="t-body-sm text-ink-muted">
                  {formatInTimeZone(h.created_at, 'UTC', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {h.modules_enabled.map((m) => (
                    <Pill key={m} tone="neutral">{m}</Pill>
                  ))}
                  {h.geofence_enabled && <Pill tone="accent">geofence</Pill>}
                  {h.allow_member_cross_complete && <Pill tone="accent">cross-complete</Pill>}
                </div>
              </div>
              <span className="t-body-sm text-ink-muted shrink-0">{h.member_count} people</span>
            </div>
          ))}
        </Card>
      </section>

      <section>
        <SectionHeader title={`Feedback — ${stats.feedback_total} total, ${stats.feedback_last_30d} in 30d`} />
        <Card className="divide-y divide-[var(--border-subtle)]">
          {feedback.length === 0 ? (
            <p className="t-body-sm text-ink-muted p-4">Nothing yet.</p>
          ) : (
            feedback.map((f) => (
              <div key={f.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <Pill tone={f.kind === 'bug' ? 'danger' : 'info'}>{f.kind}</Pill>
                  <span className="t-body-sm text-ink-muted">
                    {f.submitter_name ?? 'unknown'} · {f.household_name ?? 'no household'}
                  </span>
                </div>
                <p className="t-body-md text-ink mt-1">{f.body}</p>
              </div>
            ))
          )}
        </Card>
      </section>
    </div>
  );
}
