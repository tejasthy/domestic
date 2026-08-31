import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { requireModule } from '@/lib/data';
import { Card, LinkButton, Initials, Pill } from '@/components/ui';
import { Icon } from '@/components/brand';
import { describeCadence } from '@/lib/rotation';
import type { Chore, Profile } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ManageChoresPage() {
  const session = await requireModule('chores');
  const { me, members } = session;

  if (!me.is_admin) {
    return (
      <div className="max-w-lg space-y-4">
        <Link href="/chores" className="t-body-sm text-accent font-medium">← Chores</Link>
        <h1 className="t-display-lg text-ink">Manage chores</h1>
        <Card className="p-4">
          <p className="t-body-md text-ink">
            Only an admin can manage chores.
          </p>
          <p className="t-body-sm text-ink-muted mt-1">
            Ask{' '}
            {members.filter((m) => m.is_admin).map((m) => m.full_name.split(' ')[0]).join(' or ') ||
              'whoever set this up'}
            .
          </p>
        </Card>
      </div>
    );
  }

  const supabase = await createClient();
  const [{ data: chores }, { data: rotations }] = await Promise.all([
    supabase.from('chores').select('*').order('sort_order').returns<Chore[]>(),
    supabase
      .from('chore_rotation')
      .select('chore_id, profile_id, position')
      .order('position')
      .returns<{ chore_id: string; profile_id: string; position: number }[]>(),
  ]);

  const byId = new Map(members.map((m) => [m.id, m]));

  return (
    <div className="space-y-7 max-w-2xl">
      <header className="space-y-1">
        <Link href="/chores" className="t-body-sm text-accent font-medium">← Chores</Link>
        <div className="flex items-center justify-between gap-3 mt-1">
          <h1 className="t-display-lg text-ink">Manage chores</h1>
          <LinkButton href="/chores/manage/new" size="md">
            <Icon.Plus size={18} />
            Add chore
          </LinkButton>
        </div>
      </header>

      <div className="space-y-3">
        {(chores ?? []).map((chore) => {
          const order = (rotations ?? [])
            .filter((r) => r.chore_id === chore.id)
            .sort((a, b) => a.position - b.position)
            .map((r) => byId.get(r.profile_id))
            .filter((p): p is Profile => Boolean(p));

          return (
            <Card key={chore.id} className="p-4">
              <div className="flex items-start gap-3">
                <span className="text-2xl w-9 text-center shrink-0" aria-hidden>
                  {chore.emoji}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="t-title-md text-ink truncate">{chore.name}</h2>
                    {!chore.is_active && <Pill tone="neutral">Off</Pill>}
                  </div>
                  <p className="t-body-sm text-ink-muted mt-0.5">
                    {describeCadence(chore)}
                  </p>
                  {order.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-2 overflow-x-auto pb-1">
                      {order.map((p) => (
                        <Initials key={p.id} initials={p.initials} color={p.color} size="sm" />
                      ))}
                    </div>
                  )}
                </div>
                <LinkButton href={`/chores/manage/${chore.id}`} size="sm" tone="secondary">
                  Edit
                </LinkButton>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
