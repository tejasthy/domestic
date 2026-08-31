import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireModule } from '@/lib/data';
import { RecurringExpenseForm } from '../recurring-expense-form';

export const dynamic = 'force-dynamic';

export default async function NewRecurringExpensePage() {
  const session = await requireModule('expenses');
  if (!session.me.is_admin) redirect('/expenses/recurring');

  return (
    <div className="max-w-lg">
      <header className="mb-6">
        <Link href="/expenses/recurring" className="t-body-sm text-accent font-medium">
          ← Recurring
        </Link>
        <h1 className="t-display-lg text-ink mt-1">New recurring expense</h1>
      </header>

      <RecurringExpenseForm mode="create" me={session.me} members={session.members} />
    </div>
  );
}
