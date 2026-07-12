'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { formatMinor, formatMinorPlain, parseMajorToMinor } from '@/lib/money';
import {
  CHARGE_CODES,
  FOLIO,
  PAYMENT_CODES,
  POST_CHARGE,
  POST_PAYMENT,
  VOID_LINE,
  type Folio,
  type FolioLine,
} from '@/lib/graphql/front-desk';

/**
 * The folio — the guest's bill.
 *
 * Two rules the screen has to make visible, because they are the two the ledger is
 * built around:
 *
 *   1. A voided line is STRUCK THROUGH, not hidden. It happened. The reversing
 *      entry sits below it. Hiding it would make the screen disagree with the
 *      append-only ledger underneath, and an auditor would trust neither.
 *
 *   2. The balance is what check-out gates on. It is the biggest number on the
 *      screen, and it says plainly whether the guest can leave.
 */
export function FolioPanel({
  folioId,
  guestName,
  onClose,
  onSettled,
}: {
  folioId: string;
  guestName: string;
  onClose: () => void;
  onSettled?: () => void;
}) {
  const { role } = useAuth();
  const { data, loading, refetch } = useQuery<{ folio: Folio | null }>(FOLIO, {
    variables: { id: folioId },
    fetchPolicy: 'cache-and-network',
  });

  const [tab, setTab] = useState<'charge' | 'payment'>('charge');
  const [error, setError] = useState<string | null>(null);

  const canPost = role === 'ADMIN' || role === 'MANAGER' || role === 'FRONT_DESK';
  const canVoid = role === 'ADMIN' || role === 'MANAGER';

  const folio = data?.folio;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col border-l border-black/10 bg-[var(--background)] shadow-2xl dark:border-white/15"
      >
        <header className="flex items-start justify-between border-b border-black/10 px-5 py-4 dark:border-white/10">
          <div>
            <h2 className="text-base font-semibold">{guestName}</h2>
            <p className="mt-0.5 text-xs opacity-60">
              {folio ? `Folio ${folio.folioNo} · ${folio.status.toLowerCase()}` : 'Loading…'}
            </p>
          </div>
          <button onClick={onClose} className="text-sm opacity-60 hover:opacity-100">
            Close
          </button>
        </header>

        {loading && !folio && <p className="p-5 text-sm opacity-60">Loading folio…</p>}

        {folio && (
          <>
            {/* The number check-out gates on. */}
            <div className="border-b border-black/10 px-5 py-4 dark:border-white/10">
              <p className="text-xs uppercase tracking-wide opacity-50">Balance</p>
              <p
                className={`mt-1 text-3xl font-semibold tabular-nums ${
                  folio.balanceMinor > 0
                    ? 'text-status-ooo'
                    : folio.balanceMinor < 0
                      ? 'text-status-vacant-dirty'
                      : 'text-status-vacant-clean'
                }`}
              >
                {formatMinor(folio.balanceMinor, folio.currency)}
              </p>
              <p className="mt-1 text-xs opacity-60">
                {folio.balanceMinor > 0
                  ? 'Outstanding — the guest cannot check out until this is settled.'
                  : folio.balanceMinor < 0
                    ? 'Overpaid — refund the difference before check-out.'
                    : 'Settled. The guest can check out.'}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-3">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-black/10 text-left text-[10px] uppercase tracking-wide opacity-50 dark:border-white/10">
                    <th className="pb-1.5 font-medium">Date</th>
                    <th className="pb-1.5 font-medium">Description</th>
                    <th className="pb-1.5 text-right font-medium">Amount</th>
                    <th className="pb-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {folio.lines.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-6 text-center text-xs opacity-50">
                        Nothing posted yet.
                      </td>
                    </tr>
                  )}

                  {folio.lines.map((line) => (
                    <LineRow
                      key={line.id}
                      line={line}
                      canVoid={canVoid && folio.status === 'OPEN'}
                      onVoided={() => void refetch()}
                      onError={setError}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {error && (
              <div
                role="alert"
                className="mx-5 mb-2 rounded bg-status-ooo/10 px-3 py-2 text-xs text-status-ooo"
              >
                {error}
                <button onClick={() => setError(null)} className="ml-2 underline">
                  dismiss
                </button>
              </div>
            )}

            {folio.status !== 'OPEN' ? (
              <div className="border-t border-black/10 px-5 py-4 text-xs opacity-60 dark:border-white/10">
                This folio is {folio.status.toLowerCase()}. Nothing more can be posted to it.
              </div>
            ) : canPost ? (
              <div className="border-t border-black/10 dark:border-white/10">
                <div className="flex gap-1 px-5 pt-3">
                  {(['charge', 'payment'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={`rounded px-3 py-1.5 text-xs font-medium capitalize ${
                        tab === t
                          ? 'bg-status-occupied/15 text-status-occupied'
                          : 'opacity-60 hover:opacity-100'
                      }`}
                    >
                      Post {t}
                    </button>
                  ))}
                </div>

                {tab === 'charge' ? (
                  <ChargeForm
                    folioId={folio.id}
                    currency={folio.currency}
                    onDone={() => void refetch()}
                    onError={setError}
                  />
                ) : (
                  <PaymentForm
                    folioId={folio.id}
                    currency={folio.currency}
                    balanceMinor={folio.balanceMinor}
                    onDone={() => {
                      void refetch();
                      onSettled?.();
                    }}
                    onError={setError}
                  />
                )}
              </div>
            ) : (
              <div className="border-t border-black/10 px-5 py-4 text-xs opacity-60 dark:border-white/10">
                Your role cannot post to a folio.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Amounts render without a currency symbol — it is stated once, on the balance. */
function LineRow({
  line,
  canVoid,
  onVoided,
  onError,
}: {
  line: FolioLine;
  canVoid: boolean;
  onVoided: () => void;
  onError: (m: string) => void;
}) {
  const [voidLine, { loading }] = useMutation(VOID_LINE);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');

  // Only a CHARGE can be voided. Voiding tax alone is refused by the server —
  // "the charge stands but the tax on it does not" is either fraud or a bug — so
  // we do not offer a button that only exists to fail.
  const voidable = canVoid && !line.voided && line.type === 'CHARGE' && !line.reversesLineId;

  const submit = async () => {
    try {
      await voidLine({ variables: { input: { folioLineId: line.id, reason: reason.trim() } } });
      setConfirming(false);
      setReason('');
      onVoided();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not void that line');
    }
  };

  return (
    <>
      <tr className="border-b border-black/5 dark:border-white/5">
        <td className="py-2 text-xs tabular-nums opacity-50">{line.businessDate.slice(5)}</td>
        <td className={`py-2 ${line.voided ? 'line-through opacity-40' : ''}`}>
          <span className="text-xs">{line.description}</span>
          {line.type === 'TAX' && <span className="ml-1.5 text-[10px] opacity-50">tax</span>}
          {line.reason && (
            <span className="ml-1.5 text-[10px] opacity-60">— {line.reason}</span>
          )}
        </td>
        <td
          className={`py-2 text-right text-xs tabular-nums ${
            line.voided ? 'line-through opacity-40' : ''
          } ${line.amountMinor < 0 ? 'text-status-vacant-clean' : ''}`}
        >
          {formatMinorPlain(line.amountMinor)}
        </td>
        <td className="py-2 pl-2 text-right">
          {voidable && (
            <button
              onClick={() => setConfirming(true)}
              className="text-[10px] opacity-50 underline hover:opacity-100"
            >
              void
            </button>
          )}
        </td>
      </tr>

      {confirming && (
        <tr>
          <td colSpan={4} className="pb-2">
            <div className="rounded bg-status-ooo/5 p-2.5">
              <p className="mb-1.5 text-[11px] opacity-70">
                Voiding posts a reversing entry. The original line stays on the bill, struck
                through. Its tax is reversed with it.
              </p>
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (required — goes to the audit log)"
                  className="flex-1 rounded border border-black/15 bg-transparent px-2 py-1 text-xs dark:border-white/20"
                />
                <button
                  onClick={() => void submit()}
                  disabled={reason.trim().length < 3 || loading}
                  className="rounded bg-status-ooo px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  {loading ? '…' : 'Void'}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="px-2 text-xs opacity-60 hover:opacity-100"
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ChargeForm({
  folioId,
  currency,
  onDone,
  onError,
}: {
  folioId: string;
  currency: string;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [postCharge, { loading }] = useMutation(POST_CHARGE);
  const [code, setCode] = useState<string>('F&B');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('1');

  const minor = parseMajorToMinor(amount);
  const qty = Number(quantity);
  const valid = minor !== null && minor > 0 && Number.isInteger(qty) && qty >= 1 && description.trim();

  const submit = async () => {
    if (!valid || minor === null) return;

    try {
      await postCharge({
        variables: {
          input: {
            folioId,
            code,
            description: description.trim(),
            // Minor units on the wire. The client never computes a total or a tax —
            // the server splits GST out and the two can never disagree.
            amountMinor: minor,
            quantity: qty,
            currency,
          },
        },
      });
      setDescription('');
      setAmount('');
      setQuantity('1');
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not post that charge');
    }
  };

  return (
    <div className="grid grid-cols-[110px_1fr_90px_60px_auto] items-end gap-2 px-5 py-3">
      <Field label="Code">
        <select
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
        >
          {CHARGE_CODES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Dinner, table 4"
          className="w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
        />
      </Field>

      <Field label={`Amount`}>
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className={`w-full rounded border bg-transparent px-2 py-1.5 text-right text-sm tabular-nums dark:border-white/20 ${
            amount && minor === null ? 'border-status-ooo' : 'border-black/15'
          }`}
        />
      </Field>

      <Field label="Qty">
        <input
          inputMode="numeric"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          className="w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-right text-sm tabular-nums dark:border-white/20"
        />
      </Field>

      <button
        onClick={() => void submit()}
        disabled={!valid || loading}
        className="rounded bg-status-occupied px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        {loading ? '…' : 'Post'}
      </button>

      <p className="col-span-5 -mt-1 text-[10px] opacity-50">
        Tax is added by the server from the property&apos;s configuration — do not include it.
      </p>
    </div>
  );
}

function PaymentForm({
  folioId,
  currency,
  balanceMinor,
  onDone,
  onError,
}: {
  folioId: string;
  currency: string;
  balanceMinor: number;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [postPayment, { loading }] = useMutation(POST_PAYMENT);
  const [code, setCode] = useState<string>('CARD');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');

  const minor = parseMajorToMinor(amount);
  const valid = minor !== null && minor > 0;

  const submit = async () => {
    if (!valid || minor === null) return;

    try {
      await postPayment({
        variables: {
          input: { folioId, code, amountMinor: minor, currency, reference: reference.trim() || undefined },
        },
      });
      setAmount('');
      setReference('');
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not take that payment');
    }
  };

  return (
    <div className="grid grid-cols-[120px_1fr_110px_auto] items-end gap-2 px-5 py-3">
      <Field label="Method">
        <select
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
        >
          {PAYMENT_CODES.map((c) => (
            <option key={c} value={c}>
              {c.replace('_', ' ')}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Reference">
        <input
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="optional — card last 4, UPI ref"
          className="w-full rounded border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20"
        />
      </Field>

      <Field label="Amount">
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          className={`w-full rounded border bg-transparent px-2 py-1.5 text-right text-sm tabular-nums dark:border-white/20 ${
            amount && minor === null ? 'border-status-ooo' : 'border-black/15'
          }`}
        />
      </Field>

      <button
        onClick={() => void submit()}
        disabled={!valid || loading}
        className="rounded bg-status-vacant-clean px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
      >
        {loading ? '…' : 'Take'}
      </button>

      {balanceMinor > 0 && (
        <button
          onClick={() => setAmount((balanceMinor / 100).toFixed(2))}
          className="col-span-4 -mt-1 text-left text-[10px] underline opacity-60 hover:opacity-100"
        >
          Settle in full — {formatMinor(balanceMinor, currency)}
        </button>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide opacity-50">{label}</span>
      {children}
    </label>
  );
}
