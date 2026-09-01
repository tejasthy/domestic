'use client';

import { useState, useTransition } from 'react';
import { deleteSettlement } from '@/lib/actions';

export function SettlementRowActions({ settlementId }: { settlementId: string }) {
  const [pending, startDelete] = useTransition();
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <button
        type="button"
        className="t-body-sm text-danger font-medium shrink-0"
        disabled={pending}
        onClick={() => startDelete(async () => { await deleteSettlement(settlementId); })}
      >
        {pending ? 'Undoing…' : 'Really undo?'}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="t-body-sm text-accent font-medium shrink-0"
      onClick={() => setConfirming(true)}
    >
      Undo
    </button>
  );
}
