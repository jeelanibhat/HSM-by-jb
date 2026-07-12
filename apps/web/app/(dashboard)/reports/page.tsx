'use client';

import { useQuery } from '@apollo/client';
import { useState } from 'react';
import { Gauge } from '@/components/charts';
import { Icon } from '@/components/icons';
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Input,
  PageHeader,
  Spinner,
  StatCard,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatMinor, formatMinorPlain } from '@/lib/money';
import { DAILY_REVENUE, type DailyRevenue } from '@/lib/graphql/back-office';
import { CURRENT_PROPERTY, type Property } from '@/lib/graphql/operations';

/**
 * Daily revenue and trial balance.
 *
 * The trial balance is shown as its WORKING, not as a number:
 *
 *   billed − collected = what guests still owe
 *
 * A lone "outstanding" figure invites the reader to trust it. Showing the arithmetic
 * lets a manager see at a glance whether the books balance — and if they ever do not,
 * exactly which side is wrong.
 */
export default function ReportsPage() {
  const { data: prop } = useQuery<{ currentProperty: Property | null }>(CURRENT_PROPERTY);
  const businessDate = prop?.currentProperty?.businessDate;

  const [date, setDate] = useState<string | null>(null);
  const effective = date ?? businessDate;

  const { data, loading, error } = useQuery<{ dailyRevenueReport: DailyRevenue }>(DAILY_REVENUE, {
    variables: { date: effective },
    skip: !effective,
    fetchPolicy: 'cache-and-network',
  });

  const r = data?.dailyRevenueReport;
  const currency = r?.currency ?? 'INR';
  const balances = r ? r.grossRevenueMinor - r.paymentsMinor === r.outstandingMinor : true;

  return (
    <>
      <PageHeader
        title="Daily revenue"
        crumb="Back office"
        action={
          <Input
            type="date"
            value={effective ?? ''}
            onChange={(e) => setDate(e.target.value)}
            className="w-auto py-1.5 text-xs"
          />
        }
      />

      {error && <Alert tone="danger">{error.message}</Alert>}
      {loading && !r && <Spinner />}

      {r && (
        <>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              tone="brand"
              icon={<Icon.Money className="h-6 w-6" />}
              label="Billed today"
              value={formatMinor(r.grossRevenueMinor, currency)}
              hint="charges + tax + adjustments"
            />
            <StatCard
              tone="success"
              icon={<Icon.Trend className="h-6 w-6" />}
              label="Collected"
              value={formatMinor(r.paymentsMinor, currency)}
              hint="payments taken today"
            />
            <StatCard
              tone="danger"
              icon={<Icon.Users className="h-6 w-6" />}
              label="Guests still owe"
              value={formatMinor(r.outstandingMinor, currency)}
              hint={`${r.openFolios} open folio${r.openFolios === 1 ? '' : 's'}`}
            />
            <StatCard
              tone="warning"
              icon={<Icon.Chart className="h-6 w-6" />}
              label="Tax collected"
              value={formatMinor(r.taxMinor, currency)}
              hint="remitted, not revenue"
            />
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-3">
            <Card>
              <CardHeader title="Revenue" hint="net of tax" />

              {r.revenue.length === 0 ? (
                <EmptyState>No revenue posted.</EmptyState>
              ) : (
                <div className="space-y-1">
                  {r.revenue.map((l) => (
                    <Row key={l.code} label={l.code} count={l.count} amount={l.amountMinor} />
                  ))}
                  {r.taxMinor !== 0 && <Row label="Tax" amount={r.taxMinor} muted />}
                  {r.adjustmentsMinor !== 0 && (
                    <Row label="Adjustments" amount={r.adjustmentsMinor} muted />
                  )}
                  <Total label="Billed" amount={r.grossRevenueMinor} currency={currency} />
                </div>
              )}
            </Card>

            <Card>
              <CardHeader title="Payments taken" />

              {r.payments.length === 0 ? (
                <EmptyState>Nothing collected.</EmptyState>
              ) : (
                <div className="space-y-1">
                  {r.payments.map((l) => (
                    <Row
                      key={l.code}
                      label={l.code.replace('_', ' ')}
                      count={l.count}
                      amount={l.amountMinor}
                    />
                  ))}
                  <Total label="Collected" amount={r.paymentsMinor} currency={currency} />
                </div>
              )}
            </Card>

            {/* The trial balance, shown as its working. */}
            <Card>
              <CardHeader
                title="Trial balance"
                action={
                  <Badge tone={balances ? 'success' : 'danger'}>
                    {balances ? 'balanced' : 'does not reconcile'}
                  </Badge>
                }
              />

              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between tabular-nums">
                  <span className="text-muted">Billed</span>
                  <span>{formatMinorPlain(r.grossRevenueMinor)}</span>
                </div>
                <div className="flex justify-between tabular-nums">
                  <span className="text-muted">Collected</span>
                  <span>− {formatMinorPlain(r.paymentsMinor)}</span>
                </div>
                <div className="mt-1 flex items-baseline justify-between border-t border-line pt-2">
                  <span className="text-[13px] font-medium">Guests still owe</span>
                  <span
                    className={cn(
                      'text-lg font-semibold tabular-nums',
                      r.outstandingMinor > 0 ? 'text-danger' : 'text-success',
                    )}
                  >
                    {formatMinor(r.outstandingMinor, currency)}
                  </span>
                </div>
              </div>

              <p className="mt-3 text-xs text-muted">
                {balances ? (
                  <>The books balance across {r.openFolios} open folios.</>
                ) : (
                  <span className="font-medium text-danger">
                    These do not reconcile — something has been posted that this report cannot
                    see.
                  </span>
                )}
              </p>
            </Card>
          </div>

          <Card className="mt-5">
            <CardHeader
              title="Occupancy"
              hint="frozen by the night audit — these numbers do not move"
            />

            {r.snapshot ? (
              <div className="grid items-center gap-6 sm:grid-cols-[220px_1fr]">
                <Gauge bps={r.snapshot.occupancyBps} label="Rooms sold" />

                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Metric
                    label="Sold"
                    value={`${r.snapshot.roomsSold} / ${r.snapshot.roomsAvailable}`}
                    hint="of sellable rooms"
                  />
                  <Metric
                    label="ADR"
                    value={formatMinor(r.snapshot.adrMinor, currency)}
                    hint="revenue ÷ rooms SOLD"
                  />
                  <Metric
                    label="RevPAR"
                    value={formatMinor(r.snapshot.revparMinor, currency)}
                    hint="revenue ÷ rooms AVAILABLE"
                  />
                  <Metric
                    label="Out of order"
                    value={String(r.snapshot.roomsOutOfOrder)}
                    hint="excluded from availability"
                  />
                </div>
              </div>
            ) : (
              <EmptyState>
                The night audit has not run for {r.businessDate} yet, so occupancy has not been
                frozen.
              </EmptyState>
            )}
          </Card>
        </>
      )}
    </>
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
    <div className={cn('flex justify-between text-[13px] tabular-nums', muted && 'text-muted')}>
      <span>
        {label}
        {count !== undefined && <span className="ml-1 text-[11px] text-muted">×{count}</span>}
      </span>
      <span>{formatMinorPlain(amount)}</span>
    </div>
  );
}

function Total({ label, amount, currency }: { label: string; amount: number; currency: string }) {
  return (
    <div className="mt-1.5 flex justify-between border-t border-line pt-2 text-sm font-semibold tabular-nums">
      <span>{label}</span>
      <span>{formatMinor(amount, currency)}</span>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted/70">{hint}</p>
    </div>
  );
}
