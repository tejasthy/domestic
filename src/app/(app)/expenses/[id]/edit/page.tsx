import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getExpense, requireModule } from '@/lib/data';
import { ExpenseForm } from '../../new/expense-form';

export const dynamic = 'force-dynamic';

export default async function EditExpensePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireModule('expenses');
  const { id } = await params;
  const expense = await getExpense(id);
  if (!expense) notFound();

  return (
    <div className="max-w-lg">
      <header className="mb-6">
        <Link href="/expenses" className="t-body-sm text-accent font-medium">
          ← Money
        </Link>
        <h1 className="t-display-lg text-ink mt-1">Edit expense</h1>
      </header>

      <ExpenseForm mode="edit" me={session.me} members={session.members} expense={expense} />
    </div>
  );
}
