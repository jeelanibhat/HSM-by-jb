'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { FolioPanel } from '@/components/folio-panel';
import { Icon } from '@/components/icons';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
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

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'arrivals', label: 'Arrivals' },
  { key: 'departures', label: 'Departures' },
  { key: 'inHouse', label: 'In house' },
];

/**
 * The front desk.
 *
 * Everything is keyed on the property's BUSINESS DATE, not today's calendar date
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
    frontDeskBoard: {
      businessDate: string;
      arrivals: DeskRow[];
      departures: DeskRow[];
      inHouse: DeskRow[];
    };
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
    <>
      <PageHeader
        title="Front desk"
        crumb="General"
        action={
          <span className="hidden items-center gap-1.5 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[11px] font-medium text-brand sm:inline-flex">
            <Icon.Calendar className="h-3.5 w-3.5" />
            {businessDate ?? '…'}
          </span>
        }
      />

      <Card padded={false}>
        <div className="flex gap-1 border-b border-line px-4 sm:px-5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 px-3 py-3.5 text-[13px] transition-colors',
                tab === t.key
                  ? 'border-brand font-medium text-brand'
                  : 'border-transparent text-muted hover:text-ink',
              )}
            >
              {t.label}
              <span
                className={cn(
                  'rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                  tab === t.key ? 'bg-brand-50 text-brand' : 'bg-line text-muted',
                )}
              >
                {counts[t.key]}
              </span>
            </button>
          ))}
        </div>

        <div className="p-4 sm:p-5">
          {message && (
            <div className="mb-4">
              <Alert
                tone={message.kind === 'ok' ? 'success' : 'danger'}
                onDismiss={() => setMessage(null)}
              >
                {message.text}
              </Alert>
            </div>
          )}

          {loading && !board && <Spinner />}

          {board && rows.length === 0 && (
            <EmptyState>
              {tab === 'arrivals' && 'Nobody due to arrive today.'}
              {tab === 'departures' && 'Nobody due to leave today.'}
              {tab === 'inHouse' && 'The hotel is empty.'}
            </EmptyState>
          )}

          {rows.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <Th>Guest</Th>
                  <Th>Room</Th>
                  <Th>Stay</Th>
                  <Th align="right">Balance</Th>
                  <Th align="right">Action</Th>
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
            </Table>
          )}
        </div>
      </Card>

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
    </>
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
      onMessage({
        kind: 'ok',
        text: `${row.guestName} checked out. Room ${row.roomNumber} is now dirty.`,
      });
      onRefetch();
    } catch (e) {
      // The server refuses check-out on a non-zero balance and says how much is
      // owed. Surfacing it verbatim is more useful than "check-out failed".
      onMessage({ kind: 'err', text: e instanceof Error ? e.message : 'Check-out failed' });
    }
  };

  const owes = row.balanceMinor > 0;
  const initials = row.guestName
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');

  return (
    <>
      <tr className="group">
        <Td>
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand">
              {initials}
            </span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-medium">{row.guestName}</span>
                {row.vip && <Badge tone="warning">VIP</Badge>}
              </div>
              <p className="text-[11px] text-muted">
                {row.confirmationNo} · {row.adults + row.children} guest
                {row.adults + row.children > 1 ? 's' : ''}
              </p>
            </div>
          </div>
        </Td>

        <Td>
          {row.roomNumber ? (
            <span className="text-[13px] font-medium tabular-nums">{row.roomNumber}</span>
          ) : (
            <Badge tone="danger">unassigned</Badge>
          )}
          <span className="ml-1.5 text-[11px] text-muted">{row.roomTypeCode}</span>
        </Td>

        <Td className="text-[12px] tabular-nums text-muted">
          {row.arrivalDate.slice(5)} → {row.departureDate.slice(5)}
        </Td>

        <Td
          align="right"
          className={cn(
            'text-[13px] font-medium tabular-nums',
            owes ? 'text-danger' : row.folioId ? 'text-success' : 'text-muted/50',
          )}
        >
          {row.folioId ? formatMinor(row.balanceMinor, currency) : '—'}
        </Td>

        <Td align="right">
          <div className="flex items-center justify-end gap-2">
            {/* The server redacts folioId entirely for roles that may not touch
                cashiering, so this is already absent for housekeeping — but gate it
                explicitly too, so the intent is readable at the call site. */}
            {row.folioId && canOperate && (
              <Button variant="outline" size="sm" onClick={onOpenFolio}>
                Folio
              </Button>
            )}

            {canOperate &&
              tab === 'arrivals' &&
              (row.roomId ? (
                <Button size="sm" onClick={() => void doCheckIn()} disabled={checkingIn}>
                  {checkingIn ? '…' : 'Check in'}
                </Button>
              ) : (
                // Check-in without a room is refused by the server. Offer the fix
                // instead of a button that only exists to fail.
                <Button
                  size="sm"
                  variant="outline"
                  className="border-danger/40 text-danger"
                  onClick={() => setAssigning(true)}
                >
                  Assign room
                </Button>
              ))}

            {canOperate && tab !== 'arrivals' && row.status === 'CHECKED_IN' && (
              <Button
                size="sm"
                variant={owes ? 'outline' : 'success'}
                onClick={() => void doCheckOut()}
                disabled={checkingOut}
                title={owes ? 'The folio must be settled first' : undefined}
              >
                {checkingOut ? '…' : 'Check out'}
              </Button>
            )}
          </div>
        </Td>
      </tr>

      {assigning && (
        <tr>
          <td colSpan={5} className="pb-3">
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
   * The server rejects a room of the wrong type and an out-of-order room, so filter
   * those out — a clerk should not be offered a choice that can only fail.
   *
   * A room already booked for overlapping dates is NOT filtered: the exclusion
   * constraint decides that, and it needs the dates to do so. Clicking such a room
   * gets a precise answer — "Room 101 is already booked for overlapping dates" —
   * which is more useful than the room silently not appearing.
   */
  const candidates = (data?.rooms ?? []).filter(
    (r) => r.roomTypeId === row.roomTypeId && r.status !== 'OOO' && r.status !== 'OOS',
  );

  const pick = async (roomId: string) => {
    try {
      await assign({ variables: { input: { reservationRoomId: row.reservationRoomId, roomId } } });
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not assign that room');
    }
  };

  return (
    /**
     * Named, because a bare grid of numbers tells a screen-reader user nothing about
     * WHOSE room they are picking — and two of these can be open at once (one clerk
     * assigning while another's mutation is still in flight), which makes "the button
     * labelled 101" genuinely ambiguous to a human and a machine alike.
     */
    <div
      role="group"
      aria-label={`Rooms for ${row.guestName}`}
      className="rounded-lg bg-canvas p-3"
    >
      <p className="mb-2 text-[11px] text-muted">
        Rooms of type <strong className="font-semibold text-ink">{row.roomTypeCode}</strong> that
        are not out of order:
      </p>

      <div className="flex flex-wrap gap-1.5">
        {candidates.length === 0 && (
          <span className="text-xs text-danger">No sellable rooms of this type.</span>
        )}

        {candidates.map((r) => (
          <button
            key={r.id}
            onClick={() => void pick(r.id)}
            disabled={loading}
            className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs font-medium tabular-nums transition-colors hover:border-brand hover:text-brand disabled:opacity-40"
          >
            {r.number}
          </button>
        ))}

        <Button variant="ghost" size="sm" onClick={onCancel} className="ml-auto">
          Cancel
        </Button>
      </div>
    </div>
  );
}
