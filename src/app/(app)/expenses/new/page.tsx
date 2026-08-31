import Link from 'next/link';
import { requireModule } from '@/lib/data';
import { ExpenseForm } from './expense-form';

export const dynamic = 'force-dynamic';

export default async function NewExpensePage() {
  const session = await requireModule('expenses');

  return (
    <div className="max-w-lg">
      <header className="mb-6">
        <Link href="/expenses" className="t-body-sm text-accent font-medium">
          ← Money
        </Link>
        <h1 className="t-display-lg text-ink mt-1">Add an expense</h1>
      </header>

      <ExpenseForm me={session.me} members={session.members} />
    </div>
  );
}
