'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { Alert, Badge, Button, Field, Input, Select, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
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
 *   1. A voided line is STRUCK THROUGH, not hidden. It happened. The reversing entry
 *      sits below it. Hiding it would make the screen disagree with the append-only
 *      ledger underneath, and an auditor would trust neither.
 *
 *   2. The balance is what check-out gates on. It is the biggest thing on the panel
 *      and it says plainly whether the guest can leave.
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
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-2xl flex-col bg-card shadow-pop"
      >
        <header className="flex shrink-0 items-start justify-between border-b border-line px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">{guestName}</h2>
            {folio && (
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                Folio {folio.folioNo}
                <Badge tone={folio.status === 'OPEN' ? 'brand' : 'neutral'}>
                  {folio.status.toLowerCase()}
                </Badge>
              </p>
            )}
          </div>

          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-canvas hover:text-ink">
            <Icon.Close />
          </button>
        </header>

        {loading && !folio && (
          <div className="px-5">
            <Spinner label="Loading folio…" />
          </div>
        )}

        {folio && (
          <>
            {/* The number check-out gates on. */}
            <div
              className={cn(
                'shrink-0 border-b border-line px-5 py-4',
                folio.balanceMinor > 0
                  ? 'bg-danger-soft'
                  : folio.balanceMinor < 0
                    ? 'bg-warning-soft'
                    : 'bg-success-soft',
              )}
            >
              <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">Balance</p>
              <p
                className={cn(
                  'mt-0.5 text-3xl font-semibold tabular-nums',
                  folio.balanceMinor > 0
                    ? 'text-danger'
                    : folio.balanceMinor < 0
                      ? 'text-warning'
                      : 'text-success',
                )}
              >
                {formatMinor(folio.balanceMinor, folio.currency)}
              </p>
              <p className="mt-1 text-xs opacity-80">
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
                  <tr className="border-b border-line text-left text-[11px] font-medium uppercase tracking-wide text-muted">
                    <th className="pb-2">Date</th>
                    <th className="pb-2">Description</th>
                    <th className="pb-2 text-right">Amount</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {folio.lines.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-xs text-muted">
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
              <div className="shrink-0 px-5 pb-2">
                <Alert tone="danger" onDismiss={() => setError(null)}>
                  {error}
                </Alert>
              </div>
            )}

            {folio.status !== 'OPEN' ? (
              <div className="shrink-0 border-t border-line px-5 py-4 text-xs text-muted">
                This folio is {folio.status.toLowerCase()}. Nothing more can be posted to it.
              </div>
            ) : canPost ? (
              <div className="shrink-0 border-t border-line">
                <div className="flex gap-1 px-5 pt-3">
                  {(['charge', 'payment'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setTab(t)}
                      className={cn(
                        'rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                        tab === t ? 'bg-brand-50 text-brand' : 'text-muted hover:text-ink',
                      )}
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
              <div className="shrink-0 border-t border-line px-5 py-4 text-xs text-muted">
                Your role cannot post to a folio.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Amounts render bare — the currency is stated once, on the balance. */
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

  // Only a CHARGE can be voided. Voiding tax alone is refused by the server — "the
  // charge stands but the tax on it does not" is either fraud or a bug — so we do
  // not offer a button that only exists to fail.
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
      <tr className="border-b border-line/60">
        <td className="py-2.5 text-[11px] tabular-nums text-muted">{line.businessDate.slice(5)}</td>

        <td className={cn('py-2.5', line.voided && 'line-through opacity-45')}>
          <span className="text-[13px]">{line.description}</span>
          {line.type === 'TAX' && (
            <span className="ml-1.5 rounded bg-line px-1 text-[9px] uppercase text-muted">tax</span>
          )}
          {line.reason && <p className="text-[10px] text-muted">— {line.reason}</p>}
        </td>

        <td
          className={cn(
            'py-2.5 text-right text-[13px] tabular-nums',
            line.voided && 'line-through opacity-45',
            line.amountMinor < 0 && 'text-success',
          )}
        >
          {formatMinorPlain(line.amountMinor)}
        </td>

        <td className="py-2.5 pl-2 text-right">
          {voidable && (
            <button
              onClick={() => setConfirming(true)}
              className="text-[10px] font-medium text-muted underline-offset-2 hover:text-danger hover:underline"
            >
              void
            </button>
          )}
        </td>
      </tr>

      {confirming && (
        <tr>
          <td colSpan={4} className="pb-2.5">
            <div className="rounded-lg bg-danger-soft p-3">
              <p className="mb-2 text-[11px] text-danger/90">
                Voiding posts a reversing entry. The original line stays on the bill, struck
                through. Its tax is reversed with it.
              </p>
              <div className="flex gap-2">
                <Input
                  autoFocus
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (required — goes to the audit log)"
                  className="bg-card"
                />
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => void submit()}
                  disabled={reason.trim().length < 3 || loading}
                >
                  {loading ? '…' : 'Void'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
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
  const valid =
    minor !== null && minor > 0 && Number.isInteger(qty) && qty >= 1 && description.trim() !== '';

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
            // the server splits GST out, so the two can never disagree.
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
    <div className="px-5 py-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[110px_1fr_100px_64px_auto]">
        <Field label="Code">
          <Select value={code} onChange={(e) => setCode(e.target.value)}>
            {CHARGE_CODES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Description">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Dinner, table 4"
          />
        </Field>

        <Field label="Amount">
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            invalid={Boolean(amount) && minor === null}
            className="text-right tabular-nums"
          />
        </Field>

        <Field label="Qty">
          <Input
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            className="text-right tabular-nums"
          />
        </Field>

        <div className="flex items-end">
          <Button onClick={() => void submit()} disabled={!valid || loading} className="w-full">
            {loading ? '…' : 'Post'}
          </Button>
        </div>
      </div>

      <p className="mt-2 text-[10px] text-muted">
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
          input: {
            folioId,
            code,
            amountMinor: minor,
            currency,
            reference: reference.trim() || undefined,
          },
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
    <div className="px-5 py-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[130px_1fr_120px_auto]">
        <Field label="Method">
          <Select value={code} onChange={(e) => setCode(e.target.value)}>
            {PAYMENT_CODES.map((c) => (
              <option key={c} value={c}>
                {c.replace('_', ' ')}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Reference">
          <Input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="card last 4, UPI ref…"
          />
        </Field>

        <Field label="Amount">
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            invalid={Boolean(amount) && minor === null}
            className="text-right tabular-nums"
          />
        </Field>

        <div className="flex items-end">
          <Button
            variant="success"
            onClick={() => void submit()}
            disabled={!valid || loading}
            className="w-full"
          >
            {loading ? '…' : 'Take'}
          </Button>
        </div>
      </div>

      {balanceMinor > 0 && (
        <button
          onClick={() => setAmount((balanceMinor / 100).toFixed(2))}
          className="mt-2 text-[11px] font-medium text-brand hover:underline"
        >
          Settle in full — {formatMinor(balanceMinor, currency)}
        </button>
      )}
    </div>
  );
}
