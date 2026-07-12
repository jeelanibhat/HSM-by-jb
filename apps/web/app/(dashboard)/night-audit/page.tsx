'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, Card, CardHeader, PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import { NIGHT_AUDIT_RUNS, RUN_NIGHT_AUDIT, type AuditStep } from '@/lib/graphql/back-office';
import { CURRENT_PROPERTY, type Property } from '@/lib/graphql/operations';

const STEP_LABEL: Record<string, string> = {
  POST_ROOM_CHARGES: 'Post room & tax charges',
  MARK_NO_SHOWS: 'Mark no-shows, release rooms',
  SNAPSHOT_STATS: 'Freeze occupancy, ADR, RevPAR',
  ADVANCE_BUSINESS_DATE: 'Advance the business date',
};

/**
 * Night audit — closing the trading day.
 *
 * The screen makes two things unmissable, because both surprise people:
 *
 *   1. This MOVES THE BUSINESS DATE. Every charge posted afterwards belongs to the
 *      next trading day. It is not an "export" or a "refresh".
 *
 *   2. It is SAFE TO RE-RUN. A failed audit resumes from the step that failed, and a
 *      guest cannot be charged twice for the same night — the database refuses.
 *      Operators who do not know that will sit on a failed audit at 3am rather than
 *      press the button again, which is far worse.
 */
export default function NightAuditPage() {
  const { role } = useAuth();
  const [result, setResult] = useState<{
    businessDate: string;
    newBusinessDate?: string;
    steps: AuditStep[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: prop, refetch: refetchProperty } = useQuery<{ currentProperty: Property | null }>(
    CURRENT_PROPERTY,
  );

  const { data: history, refetch: refetchHistory } = useQuery<{
    nightAuditRuns: Array<{
      id: string;
      businessDate: string;
      status: string;
      completedAt?: string | null;
    }>;
  }>(NIGHT_AUDIT_RUNS, { fetchPolicy: 'cache-and-network' });

  const [run, { loading }] = useMutation(RUN_NIGHT_AUDIT);

  const canRun = role === 'ADMIN' || role === 'MANAGER';
  const businessDate = prop?.currentProperty?.businessDate;

  const execute = async () => {
    setError(null);
    setResult(null);

    try {
      const { data } = await run();
      setResult(data.runNightAudit);
      await Promise.all([refetchProperty(), refetchHistory()]);
    } catch (e) {
      // A failed audit names the step and why. "Price the night, then run again — it
      // will resume from here" is actionable; "audit failed" is not.
      setError(e instanceof Error ? e.message : 'The night audit failed.');
      await refetchHistory();
    }
  };

  const lastFailed = history?.nightAuditRuns.find((r) => r.status === 'FAILED');

  return (
    <>
      <PageHeader title="Night audit" crumb="Back office" />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-50 text-brand">
              <Icon.Moon className="h-6 w-6" />
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                Current business date
              </p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums">{businessDate ?? '…'}</p>

              <ul className="mt-4 space-y-1.5 text-[13px] text-muted">
                {Object.values(STEP_LABEL).map((s) => (
                  <li key={s} className="flex items-center gap-2">
                    <span className="h-1 w-1 rounded-full bg-muted/50" />
                    {s}
                    {s.startsWith('Advance') && businessDate && (
                      <strong className="font-semibold text-ink">→ {nextDay(businessDate)}</strong>
                    )}
                  </li>
                ))}
              </ul>

              {lastFailed && !result && (
                <div className="mt-4">
                  <Alert tone="warning">
                    The audit for <strong>{lastFailed.businessDate}</strong> failed part-way.
                    Running it again resumes from the step that failed — completed steps are not
                    repeated, and nobody is charged twice.
                  </Alert>
                </div>
              )}

              {canRun ? (
                <Button onClick={() => void execute()} disabled={loading || !businessDate} className="mt-5">
                  {loading ? 'Running…' : lastFailed ? 'Resume night audit' : 'Run night audit'}
                </Button>
              ) : (
                <p className="mt-5 text-xs text-muted">
                  Only a manager or admin can close the books.
                </p>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Recent runs" />

          {(history?.nightAuditRuns.length ?? 0) === 0 ? (
            <p className="py-4 text-center text-xs text-muted">The audit has never run.</p>
          ) : (
            <div className="space-y-1">
              {history!.nightAuditRuns.slice(0, 8).map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between rounded-lg px-2 py-2 text-[13px] hover:bg-canvas"
                >
                  <span className="tabular-nums">{r.businessDate}</span>
                  <Badge
                    tone={
                      r.status === 'COMPLETED'
                        ? 'success'
                        : r.status === 'FAILED'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {r.status.toLowerCase()}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {error && (
        <div className="mt-5">
          <Alert tone="danger" onDismiss={() => setError(null)}>
            <p className="font-medium">The audit stopped.</p>
            <p className="mt-1 text-xs">{error}</p>
            <p className="mt-2 text-xs opacity-80">
              Completed steps are committed. Fix the cause and run it again — it resumes from
              where it stopped.
            </p>
          </Alert>
        </div>
      )}

      {result && (
        <Card className="mt-5 border-success/30 bg-success-soft">
          <p className="text-sm font-semibold text-success">
            Audit complete — business date {result.businessDate} → {result.newBusinessDate}
          </p>

          <div className="mt-3 space-y-1.5">
            {result.steps.map((s) => (
              <div
                key={s.step}
                className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg bg-card px-3 py-2 text-[13px]"
              >
                <span
                  className={cn(
                    'grid h-4 w-4 shrink-0 place-items-center rounded-full text-[9px] text-white',
                    s.status === 'COMPLETED' ? 'bg-success' : 'bg-danger',
                  )}
                >
                  {s.status === 'COMPLETED' ? '✓' : '!'}
                </span>
                <span className="font-medium">{STEP_LABEL[s.step] ?? s.step}</span>
                <span className="text-xs text-muted">{s.detail}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

/** Business dates are plain strings — never touch the local timezone. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
