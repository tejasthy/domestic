'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { deleteExpense } from '@/lib/actions';
import { Button } from '@/components/ui';

export function ExpenseRowActions({ expenseId }: { expenseId: string }) {
  const [pending, startDelete] = useTransition();
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-center gap-3 pt-2 mt-1 border-t border-subtle">
      <Link href={`/expenses/${expenseId}/edit`} className="t-body-sm text-accent font-medium">
        Edit
      </Link>
      {confirming ? (
        <Button
          type="button"
          tone="danger"
          size="sm"
          disabled={pending}
          onClick={() => startDelete(async () => { await deleteExpense(expenseId); })}
        >
          {pending ? 'Deleting…' : 'Really delete?'}
        </Button>
      ) : (
        <button
          type="button"
          className="t-body-sm text-danger font-medium"
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      )}
    </div>
  );
}
