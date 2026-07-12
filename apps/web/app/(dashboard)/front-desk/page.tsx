'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { FolioPanel } from '@/components/folio-panel';
import { useAuth } from '@/lib/auth-context';
import { formatMinor } from '@/lib/money';
import {
  AVAILABLE_ROOMS,
  CHECK_IN,
  CHECK_OUT,
  FRONT_DESK_BOARD,
  type DeskRow,
} from '@/lib/graphql/front-desk';
import { ASSIGN_ROOM } from '@/lib/graphql/tape-chart';
import { CURRENT_PROPERTY, type Property } from '@/lib/graphql/operations';

type Tab = 'arrivals' | 'departures' | 'inHouse';

/**
 * The front desk. Arrivals, departures, who is in the building.
 *
 * Everything is keyed on the property's BUSINESS DATE, not on today's calendar date
 * (TDD §6). A clerk working at 01:00 is still working yesterday's trading day, and
 * the arrivals list must show yesterday's arrivals — not tomorrow's.
 */
export default function FrontDeskPage() {
  const { role } = useAuth();
  const [tab, setTab] = useState<Tab>('arrivals');
  const [openFolio, setOpenFolio] = useState<DeskRow | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const { data: prop } = useQuery<{ currentProperty: Property | null }>(CURRENT_PROPERTY);
  const businessDate = prop?.currentProperty?.businessDate;
  const currency = prop?.currentProperty?.currency ?? 'INR';

  const { data, loading, refetch } = useQuery<{
    frontDeskBoard: { businessDate: string; arrivals: DeskRow[]; departures: DeskRow[]; inHouse: DeskRow[] };
  }>(FRONT_DESK_BOARD, {
    variables: { date: businessDate },
    skip: !businessDate,
    fetchPolicy: 'cache-and-network',
  });

  const canOperate = role === 'ADMIN' || role === 'MANAGER' || role === 'FRONT_DESK';

  const board = data?.frontDeskBoard;
  const rows = board ? board[tab] : [];

  const counts = {
    arrivals: board?.arrivals.length ?? 0,
    departures: board?.departures.length ?? 0,
    inHouse: board?.inHouse.length ?? 0,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Front desk</h1>
          <p className="mt-1 text-sm opacity-60">
            Business date <strong className="font-medium">{businessDate ?? '…'}</strong>
            <span className="ml-2 text-xs opacity-70">
              (moves only at night audit — not today&apos;s calendar date)
            </span>
          </p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-black/10 dark:border-white/10">
        {(
          [
            ['arrivals', 'Arrivals'],
            ['departures', 'Departures'],
            ['inHouse', 'In house'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === key
                ? 'border-status-occupied font-medium text-status-occupied'
                : 'border-transparent opacity-60 hover:opacity-100'
            }`}
          >
            {label}
            <span className="ml-1.5 rounded bg-black/5 px-1.5 py-0.5 text-[10px] tabular-nums dark:bg-white/10">
              {counts[key]}
            </span>
          </button>
        ))}
      </div>

      {message && (
        <div
          role="status"
          className={`rounded-md px-3 py-2 text-sm ${
            message.kind === 'ok'
              ? 'bg-status-vacant-clean/15 text-status-vacant-clean'
              : 'bg-status-ooo/15 text-status-ooo'
          }`}
        >
          {message.text}
          <button onClick={() => setMessage(null)} className="ml-3 text-xs underline">
            dismiss
          </button>
        </div>
      )}

      {loading && !board && <p className="text-sm opacity-60">Loading…</p>}

      {board && rows.length === 0 && (
        <p className="rounded-md border border-dashed border-black/15 px-4 py-8 text-center text-sm opacity-60 dark:border-white/15">
          {tab === 'arrivals' && 'Nobody due to arrive today.'}
          {tab === 'departures' && 'Nobody due to leave today.'}
          {tab === 'inHouse' && 'The hotel is empty.'}
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-md border border-black/10 dark:border-white/10">
          <table className="w-full text-sm">
            <thead className="bg-black/[0.02] text-left text-[10px] uppercase tracking-wide opacity-50 dark:bg-white/[0.03]">
              <tr>
                <th className="px-3 py-2 font-medium">Guest</th>
                <th className="px-3 py-2 font-medium">Room</th>
                <th className="px-3 py-2 font-medium">Stay</th>
                <th className="px-3 py-2 text-right font-medium">Balance</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <DeskRowView
                  key={row.reservationRoomId}
                  row={row}
                  tab={tab}
                  currency={currency}
                  canOperate={canOperate}
                  onRefetch={() => void refetch()}
                  onMessage={setMessage}
                  onOpenFolio={() => setOpenFolio(row)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openFolio?.folioId && (
        <FolioPanel
          folioId={openFolio.folioId}
          guestName={openFolio.guestName}
          onClose={() => {
            setOpenFolio(null);
            void refetch();
          }}
          onSettled={() => void refetch()}
        />
      )}
    </div>
  );
}

function DeskRowView({
  row,
  tab,
  currency,
  canOperate,
  onRefetch,
  onMessage,
  onOpenFolio,
}: {
  row: DeskRow;
  tab: Tab;
  currency: string;
  canOperate: boolean;
  onRefetch: () => void;
  onMessage: (m: { kind: 'ok' | 'err'; text: string }) => void;
  onOpenFolio: () => void;
}) {
  const [checkIn, { loading: checkingIn }] = useMutation(CHECK_IN);
  const [checkOut, { loading: checkingOut }] = useMutation(CHECK_OUT);
  const [assigning, setAssigning] = useState(false);

  const doCheckIn = async () => {
    try {
      await checkIn({ variables: { reservationId: row.reservationId } });
      onMessage({ kind: 'ok', text: `${row.guestName} checked in to room ${row.roomNumber}.` });
      onRefetch();
    } catch (e) {
      onMessage({ kind: 'err', text: e instanceof Error ? e.message : 'Check-in failed' });
    }
  };

  const doCheckOut = async () => {
    try {
      await checkOut({ variables: { reservationId: row.reservationId } });
      onMessage({ kind: 'ok', text: `${row.guestName} checked out. Room ${row.roomNumber} is now dirty.` });
      onRefetch();
    } catch (e) {
      // The server refuses check-out on a non-zero balance and says how much is
      // owed. Surfacing it verbatim is more useful than "check-out failed".
      onMessage({ kind: 'err', text: e instanceof Error ? e.message : 'Check-out failed' });
    }
  };

  const owes = row.balanceMinor > 0;

  return (
    <>
      <tr className="border-t border-black/5 dark:border-white/5">
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <span className="font-medium">{row.guestName}</span>
            {row.vip && (
              <span className="rounded bg-status-vacant-dirty/20 px-1 text-[9px] font-medium text-status-vacant-dirty">
                VIP
              </span>
            )}
          </div>
          <div className="text-[11px] opacity-50">
            {row.confirmationNo} · {row.adults + row.children} guest
            {row.adults + row.children > 1 ? 's' : ''}
          </div>
        </td>

        <td className="px-3 py-2.5">
          {row.roomNumber ? (
            <span className="tabular-nums">{row.roomNumber}</span>
          ) : (
            <span className="text-xs text-status-ooo">unassigned</span>
          )}
          <span className="ml-1.5 text-[10px] opacity-40">{row.roomTypeCode}</span>
        </td>

        <td className="px-3 py-2.5 text-xs tabular-nums opacity-70">
          {row.arrivalDate.slice(5)} → {row.departureDate.slice(5)}
        </td>

        <td
          className={`px-3 py-2.5 text-right text-sm tabular-nums ${
            owes ? 'text-status-ooo' : row.folioId ? 'text-status-vacant-clean' : 'opacity-40'
          }`}
        >
          {row.folioId ? formatMinor(row.balanceMinor, currency) : '—'}
        </td>

        <td className="px-3 py-2.5 text-right">
          <div className="flex items-center justify-end gap-2">
            {row.folioId && (
              <button
                onClick={onOpenFolio}
                className="text-xs underline underline-offset-2 opacity-60 hover:opacity-100"
              >
                Folio
              </button>
            )}

            {canOperate && tab === 'arrivals' && (
              row.roomId ? (
                <button
                  onClick={() => void doCheckIn()}
                  disabled={checkingIn}
                  className="rounded bg-status-occupied px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
                >
                  {checkingIn ? '…' : 'Check in'}
                </button>
              ) : (
                // Check-in without a room is refused by the server. Offer the fix
                // instead of a button that only exists to fail.
                <button
                  onClick={() => setAssigning(true)}
                  className="rounded border border-status-ooo/40 px-2.5 py-1 text-xs font-medium text-status-ooo"
                >
                  Assign room
                </button>
              )
            )}

            {canOperate && tab !== 'arrivals' && row.status === 'CHECKED_IN' && (
              <button
                onClick={() => void doCheckOut()}
                disabled={checkingOut}
                title={owes ? 'The folio must be settled first' : undefined}
                className={`rounded px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40 ${
                  owes ? 'bg-black/25 dark:bg-white/25' : 'bg-status-vacant-clean'
                }`}
              >
                {checkingOut ? '…' : 'Check out'}
              </button>
            )}
          </div>
        </td>
      </tr>

      {assigning && (
        <tr>
          <td colSpan={5} className="px-3 pb-3">
            <AssignRoomPicker
              row={row}
              onDone={() => {
                setAssigning(false);
                onRefetch();
              }}
              onCancel={() => setAssigning(false)}
              onError={(t) => onMessage({ kind: 'err', text: t })}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function AssignRoomPicker({
  row,
  onDone,
  onCancel,
  onError,
}: {
  row: DeskRow;
  onDone: () => void;
  onCancel: () => void;
  onError: (m: string) => void;
}) {
  const { data } = useQuery<{
    rooms: Array<{ id: string; number: string; status: string; roomTypeId: string }>;
  }>(AVAILABLE_ROOMS);
  const [assign, { loading }] = useMutation(ASSIGN_ROOM);

  /**
   * The server rejects a room of the wrong type and an out-of-order room. Filter
   * here too — a clerk should not be offered a choice that can only fail.
   *
   * A room already booked for overlapping dates is NOT filtered out: the exclusion
   * constraint decides that, and it needs the dates to do so. Clicking such a room
   * gets a precise answer — "Room 101 is already booked for overlapping dates" —
   * which is more useful than the room silently not appearing.
   */
  const candidates = (data?.rooms ?? []).filter(
    (r) => r.roomTypeId === row.roomTypeId && r.status !== 'OOO' && r.status !== 'OOS',
  );

  const pick = async (roomId: string) => {
    try {
      await assign({
        variables: { input: { reservationRoomId: row.reservationRoomId, roomId } },
      });
      onDone();
    } catch (e) {
      // The exclusion constraint speaks here: "Room 101 is already booked for
      // overlapping dates."
      onError(e instanceof Error ? e.message : 'Could not assign that room');
    }
  };

  return (
    <div className="rounded bg-black/[0.03] p-2.5 dark:bg-white/[0.05]">
      <p className="mb-2 text-[11px] opacity-70">
        Rooms of type <strong>{row.roomTypeCode}</strong> that are not out of order:
      </p>
      <div className="flex flex-wrap gap-1.5">
        {candidates.length === 0 && (
          <span className="text-xs text-status-ooo">No sellable rooms of this type.</span>
        )}
        {candidates.map((r) => (
          <button
            key={r.id}
            onClick={() => void pick(r.id)}
            disabled={loading}
            className="rounded border border-black/15 px-2 py-1 text-xs tabular-nums hover:bg-black/5 disabled:opacity-40 dark:border-white/20 dark:hover:bg-white/10"
          >
            {r.number}
          </button>
        ))}
        <button onClick={onCancel} className="px-2 text-xs opacity-60 hover:opacity-100">
          Cancel
        </button>
      </div>
    </div>
  );
}
