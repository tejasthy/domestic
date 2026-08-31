import { redirect } from 'next/navigation';
import { requireModule } from '@/lib/data';
import { ChoreForm } from '../chore-form';

export const dynamic = 'force-dynamic';

export default async function NewChorePage() {
  const session = await requireModule('chores');
  if (!session.me.is_admin) redirect('/chores/manage');

  return (
    <div className="max-w-lg space-y-4">
      <h1 className="t-display-lg text-ink">Add a chore</h1>
      <ChoreForm mode="create" members={session.members} />
    </div>
  );
}
