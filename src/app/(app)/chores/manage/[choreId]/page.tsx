import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireModule } from '@/lib/data';
import { ChoreForm } from '../chore-form';
import type { Chore } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function EditChorePage({
  params,
}: {
  params: Promise<{ choreId: string }>;
}) {
  const { choreId } = await params;
  const session = await requireModule('chores');
  if (!session.me.is_admin) redirect('/chores/manage');

  const supabase = await createClient();
  const [{ data: chore }, { data: rotation }] = await Promise.all([
    supabase.from('chores').select('*').eq('id', choreId).single<Chore>(),
    supabase
      .from('chore_rotation')
      .select('profile_id, position')
      .eq('chore_id', choreId)
      .order('position')
      .returns<{ profile_id: string; position: number }[]>(),
  ]);

  if (!chore) notFound();

  const initialRotation = (rotation ?? []).map((r) => r.profile_id);

  return (
    <div className="max-w-lg space-y-4">
      <h1 className="t-display-lg text-ink">
        {chore.emoji} {chore.name}
      </h1>
      <ChoreForm
        mode="edit"
        chore={chore}
        initialRotation={initialRotation}
        members={session.members}
      />
    </div>
  );
}
