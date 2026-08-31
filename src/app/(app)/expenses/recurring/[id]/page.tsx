import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getRecurringExpense, requireModule } from '@/lib/data';
import { RecurringExpenseForm } from '../recurring-expense-form';

export const dynamic = 'force-dynamic';

export default async function EditRecurringExpensePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireModule('expenses');
  if (!session.me.is_admin) redirect('/expenses/recurring');

  const { id } = await params;
  const recurring = await getRecurringExpense(id);
  if (!recurring) notFound();

  return (
    <div className="max-w-lg">
      <header className="mb-6">
        <Link href="/expenses/recurring" className="t-body-sm text-accent font-medium">
          ← Recurring
        </Link>
        <h1 className="t-display-lg text-ink mt-1">Edit recurring expense</h1>
      </header>

      <RecurringExpenseForm
        mode="edit"
        me={session.me}
        members={session.members}
        recurring={recurring}
      />
    </div>
  );
}
