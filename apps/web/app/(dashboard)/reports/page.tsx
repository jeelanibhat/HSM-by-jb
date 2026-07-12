'use client';

import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { formatMinor, formatMinorPlain } from '@/lib/money';
import { DAILY_REVENUE, type DailyRevenue } from '@/lib/graphql/back-office';
import { CURRENT_PROPERTY, type Property } from '@/lib/graphql/operations';

/**
 * The daily revenue report and trial balance.
 *
 * The trial balance is shown as an equation, not a number:
 *
 *   billed − collected = what guests still owe
 *
 * A single "outstanding" figure invites the reader to trust it. Showing the working
 * lets a manager see at a glance whether the books balance — and if they ever do
 * not, exactly which side is wrong.
 */
export default function ReportsPage() {
  const { data: prop } = useQuery<{ currentProperty: Property | null }>(CURRENT_PROPERTY);
  const businessDate = prop?.currentProperty?.businessDate;

  const [date, setDate] = useState<string | null>(null);
  const effective = date ?? businessDate;

  const { data, loading, error } = useQuery<{ dailyRevenueReport: DailyRevenue }>(
    DAILY_REVENUE,
    { variables: { date: effective }, skip: !effective, fetchPolicy: 'cache-and-network' },
  );

  const r = data?.dailyRevenueReport;
  const currency = r?.currency ?? 'INR';

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Daily revenue</h1>
          <p className="mt-1 text-sm opacity-60">
            Keyed on business date — a charge posted at 01:00 belongs to the trading day that
            has not closed yet.
          </p>
        </div>

        <label className="text-xs">
          <span className="mb-1 block opacity-60">Business date</span>
          <input
            type="date"
            value={effective ?? ''}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
          />
        </label>
      </div>

      {error && (
        <div className="rounded-md bg-status-ooo/10 px-4 py-3 text-sm text-status-ooo">
          {error.message}
        </div>
      )}

      {loading && !r && <p className="text-sm opacity-60">Loading…</p>}

      {r && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Section title="Revenue" hint="net of tax">
              {r.revenue.length === 0 && <Empty>No revenue posted.</Empty>}
              {r.revenue.map((l) => (
                <Row key={l.code} label={l.code} count={l.count} amount={l.amountMinor} />
              ))}
              {r.taxMinor !== 0 && <Row label="Tax" amount={r.taxMinor} muted />}
              {r.adjustmentsMinor !== 0 && (
                <Row label="Adjustments" amount={r.adjustmentsMinor} muted />
              )}
              <Total label="Billed" amount={r.grossRevenueMinor} currency={currency} />
            </Section>

            <Section title="Payments taken">
              {r.payments.length === 0 && <Empty>Nothing collected.</Empty>}
              {r.payments.map((l) => (
                <Row key={l.code} label={l.code.replace('_', ' ')} count={l.count} amount={l.amountMinor} />
              ))}
              <Total label="Collected" amount={r.paymentsMinor} currency={currency} />
            </Section>
          </div>

          {/* The trial balance, shown as its working. */}
          <div className="rounded-md border border-black/10 p-5 dark:border-white/10">
            <h2 className="text-xs uppercase tracking-wide opacity-50">Trial balance</h2>

            <div className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between tabular-nums">
                <span className="opacity-70">Billed</span>
                <span>{formatMinorPlain(r.grossRevenueMinor)}</span>
              </div>
              <div className="flex justify-between tabular-nums">
                <span className="opacity-70">Collected</span>
                <span>− {formatMinorPlain(r.paymentsMinor)}</span>
              </div>
              <div className="mt-1 flex justify-between border-t border-black/10 pt-1.5 text-base font-semibold tabular-nums dark:border-white/10">
                <span>Guests still owe</span>
                <span
                  className={r.outstandingMinor > 0 ? 'text-status-ooo' : 'text-status-vacant-clean'}
                >
                  {formatMinor(r.outstandingMinor, currency)}
                </span>
              </div>
            </div>

            <p className="mt-2 text-xs opacity-60">
              Across {r.openFolios} open folio{r.openFolios === 1 ? '' : 's'}.
              {r.grossRevenueMinor - r.paymentsMinor === r.outstandingMinor ? (
                <span className="ml-1 text-status-vacant-clean">The books balance.</span>
              ) : (
                <span className="ml-1 font-medium text-status-ooo">
                  These do not reconcile — something has been posted that this report cannot
                  see.
                </span>
              )}
            </p>
          </div>

          <div className="rounded-md border border-black/10 p-5 dark:border-white/10">
            <h2 className="text-xs uppercase tracking-wide opacity-50">Occupancy</h2>

            {r.snapshot ? (
              <>
                <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat
                    label="Occupancy"
                    value={`${(r.snapshot.occupancyBps / 100).toFixed(1)}%`}
                    hint={`${r.snapshot.roomsSold} of ${r.snapshot.roomsAvailable} sold`}
                  />
                  <Stat
                    label="ADR"
                    value={formatMinor(r.snapshot.adrMinor, currency)}
                    hint="room revenue ÷ rooms SOLD"
                  />
                  <Stat
                    label="RevPAR"
                    value={formatMinor(r.snapshot.revparMinor, currency)}
                    hint="room revenue ÷ rooms AVAILABLE"
                  />
                  <Stat
                    label="Out of order"
                    value={String(r.snapshot.roomsOutOfOrder)}
                    hint="excluded from availability"
                  />
                </div>
                <p className="mt-3 text-xs opacity-50">
                  Frozen by the night audit. These numbers do not move if a booking is
                  cancelled later — the trading day is closed.
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm opacity-60">
                The night audit has not run for {r.businessDate} yet, so occupancy has not been
                frozen.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-black/10 p-4 dark:border-white/10">
      <h2 className="text-xs uppercase tracking-wide opacity-50">
        {title}
        {hint && <span className="ml-1.5 normal-case opacity-70">({hint})</span>}
      </h2>
      <div className="mt-2 space-y-0.5">{children}</div>
    </div>
  );
}

function Row({
  label,
  count,
  amount,
  muted,
}: {
  label: string;
  count?: number;
  amount: number;
  muted?: boolean;
}) {
  return (
    <div className={`flex justify-between text-sm tabular-nums ${muted ? 'opacity-60' : ''}`}>
      <span>
        {label}
        {count !== undefined && <span className="ml-1 text-xs opacity-50">×{count}</span>}
      </span>
      <span>{formatMinorPlain(amount)}</span>
    </div>
  );
}

function Total({ label, amount, currency }: { label: string; amount: number; currency: string }) {
  return (
    <div className="mt-1.5 flex justify-between border-t border-black/10 pt-1.5 text-sm font-semibold tabular-nums dark:border-white/10">
      <span>{label}</span>
      <span>{formatMinor(amount, currency)}</span>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide opacity-50">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] opacity-45">{hint}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-1 text-xs opacity-50">{children}</p>;
}
