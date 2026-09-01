import Link from 'next/link';
import { requireModule } from '@/lib/data';
import { PaymentForm } from './payment-form';

export const dynamic = 'force-dynamic';

export default async function NewPaymentPage() {
  const session = await requireModule('expenses');

  return (
    <div className="max-w-lg">
      <header className="mb-6">
        <Link href="/expenses" className="t-body-sm text-accent font-medium">
          ← Money
        </Link>
        <h1 className="t-display-lg text-ink mt-1">Record a payment</h1>
        <p className="t-body-md text-ink-muted mt-0.5">
          Log a Venmo, cash, or other payment that already happened — for yourself or anyone in the house.
        </p>
      </header>

      <PaymentForm me={session.me} members={session.members} />
    </div>
  );
}
