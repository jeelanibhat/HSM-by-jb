'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import {
  NIGHT_AUDIT_RUNS,
  RUN_NIGHT_AUDIT,
  type AuditStep,
} from '@/lib/graphql/back-office';
import { CURRENT_PROPERTY, type Property } from '@/lib/graphql/operations';

/**
 * Night audit — closing the trading day.
 *
 * The screen makes two things unmissable, because both surprise people:
 *
 *   1. This MOVES THE BUSINESS DATE. Every charge posted afterwards belongs to the
 *      next trading day. It is not an "export" or a "refresh".
 *
 *   2. It is SAFE TO RE-RUN. A failed audit resumes from the step that failed, and
 *      a guest cannot be charged twice for the same night — the database refuses.
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

  const { data: prop, refetch: refetchProperty } = useQuery<{
    currentProperty: Property | null;
  }>(CURRENT_PROPERTY);

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
      // A failed audit names the step and why. "Price the night, then run again —
      // it will resume from here" is actionable; "audit failed" is not.
      setError(e instanceof Error ? e.message : 'The night audit failed.');
      await refetchHistory();
    }
  };

  const lastFailed = history?.nightAuditRuns.find((r) => r.status === 'FAILED');

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Night audit</h1>
        <p className="mt-1 text-sm opacity-60">Closes the trading day and rolls the business date.</p>
      </div>

      <div className="rounded-md border border-black/10 p-5 dark:border-white/10">
        <p className="text-xs uppercase tracking-wide opacity-50">Current business date</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{businessDate ?? '…'}</p>

        <ul className="mt-4 space-y-1 text-xs opacity-70">
          <li>· Posts room and tax charges for every in-house guest</li>
          <li>· Marks unarrived bookings as no-show and releases their rooms</li>
          <li>· Freezes occupancy, ADR and RevPAR for the night</li>
          <li>
            · Advances the business date to{' '}
            <strong className="font-medium opacity-100">
              {businessDate ? nextDay(businessDate) : '…'}
            </strong>
          </li>
        </ul>

        {lastFailed && !result && (
          <div className="mt-4 rounded bg-status-vacant-dirty/10 px-3 py-2 text-xs text-status-vacant-dirty">
            The audit for {lastFailed.businessDate} failed part-way. Running it again resumes
            from the step that failed — completed steps are not repeated, and nobody is charged
            twice.
          </div>
        )}

        {canRun ? (
          <button
            onClick={() => void execute()}
            disabled={loading || !businessDate}
            className="mt-5 rounded-md bg-status-occupied px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {loading ? 'Running…' : lastFailed ? 'Resume night audit' : 'Run night audit'}
          </button>
        ) : (
          <p className="mt-5 text-xs opacity-60">
            Only a manager or admin can close the books.
          </p>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md bg-status-ooo/10 px-4 py-3 text-sm text-status-ooo"
        >
          <p className="font-medium">The audit stopped.</p>
          <p className="mt-1 text-xs">{error}</p>
          <p className="mt-2 text-xs opacity-80">
            Completed steps are committed. Fix the cause and run it again — it resumes from
            where it stopped.
          </p>
        </div>
      )}

      {result && (
        <div className="rounded-md border border-status-vacant-clean/30 bg-status-vacant-clean/5 p-5">
          <p className="text-sm font-medium text-status-vacant-clean">
            Audit complete — business date {result.businessDate} → {result.newBusinessDate}
          </p>

          <table className="mt-3 w-full text-xs">
            <tbody>
              {result.steps.map((s) => (
                <tr key={s.step} className="border-t border-black/5 dark:border-white/5">
                  <td className="py-1.5 pr-3 font-mono text-[11px] opacity-70">{s.step}</td>
                  <td className="py-1.5 pr-3">
                    <span
                      className={
                        s.status === 'COMPLETED'
                          ? 'text-status-vacant-clean'
                          : s.status === 'FAILED'
                            ? 'text-status-ooo'
                            : 'opacity-50'
                      }
                    >
                      {s.status.toLowerCase()}
                    </span>
                  </td>
                  <td className="py-1.5 opacity-70">{s.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(history?.nightAuditRuns.length ?? 0) > 0 && (
        <div>
          <h2 className="mb-2 text-xs uppercase tracking-wide opacity-50">Recent runs</h2>
          <div className="overflow-hidden rounded-md border border-black/10 dark:border-white/10">
            <table className="w-full text-sm">
              <tbody>
                {history!.nightAuditRuns.slice(0, 10).map((r) => (
                  <tr key={r.id} className="border-b border-black/5 last:border-0 dark:border-white/5">
                    <td className="px-3 py-2 tabular-nums">{r.businessDate}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] ${
                          r.status === 'COMPLETED'
                            ? 'bg-status-vacant-clean/15 text-status-vacant-clean'
                            : r.status === 'FAILED'
                              ? 'bg-status-ooo/15 text-status-ooo'
                              : 'bg-status-vacant-dirty/15 text-status-vacant-dirty'
                        }`}
                      >
                        {r.status.toLowerCase()}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-xs opacity-50">
                      {r.completedAt ? new Date(r.completedAt).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Business dates are plain strings — never touch the local timezone. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
