'use client';

import { useMutation, useQuery, useSubscription } from '@apollo/client';
import { useCallback, useMemo, useState } from 'react';
import { PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import {
  ASSIGN_ROOM,
  RES_STATUS_STYLE,
  TAPE_CHART,
  TAPE_CHART_CHANGED,
  type ChartBlock,
  type ChartRoom,
  type TapeChartData,
  type UnassignedBlock,
} from '@/lib/graphql/tape-chart';

const CELL_W = 44; // px per night
const ROW_H = 36;

/** Business dates are plain strings; keep them out of Date's timezone entirely. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    (new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * The tape chart (TDD §7.2) — rooms down, dates across, reservations as spans.
 *
 * Blocks are positioned by BUSINESS DATE arithmetic, never by pixel guessing:
 * left = (arrival - windowStart) × cellWidth, width = nights × cellWidth. Because
 * the stay is half-open [arrival, departure), a block for the 1st→4th covers three
 * cells and STOPS at the 4th — leaving that cell free for the guest arriving the
 * same day. The grid draws same-day turnover correctly for the same reason the
 * database allows it.
 */
export default function TapeChartPage() {
  const { propertyId, role } = useAuth();
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState(14);
  const [dragging, setDragging] = useState<UnassignedBlock | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const from = start;
  const to = addDays(start, days - 1);

  const canAssign = role === 'ADMIN' || role === 'MANAGER' || role === 'FRONT_DESK';

  const { data, loading, error, refetch } = useQuery<{ tapeChart: TapeChartData }>(TAPE_CHART, {
    variables: { from, to },
    fetchPolicy: 'cache-and-network',
  });

  /**
   * Live updates. The server sends a nudge, not a patch — we refetch the window
   * we are looking at. Splicing a partial payload into the cache is how two front
   * desks end up seeing different charts; a chart that disagrees with the database
   * is worse than one that is a second stale.
   */
  useSubscription(TAPE_CHART_CHANGED, {
    variables: { propertyId },
    skip: !propertyId,
    onData: () => void refetch(),
  });

  const [assignRoom] = useMutation(ASSIGN_ROOM);

  const chart = data?.tapeChart;

  const blocksByRoom = useMemo(() => {
    const map = new Map<string, ChartBlock[]>();
    for (const b of chart?.blocks ?? []) {
      const list = map.get(b.roomId) ?? [];
      list.push(b);
      map.set(b.roomId, list);
    }
    return map;
  }, [chart?.blocks]);

  const onDrop = useCallback(
    async (room: ChartRoom) => {
      if (!dragging || !canAssign) return;

      const booking = dragging;
      setDragging(null);

      // Fail early and locally on the one rule the user can see for themselves.
      // The server still checks; this just avoids a pointless round trip.
      if (booking.roomTypeId !== room.roomTypeId) {
        setToast({
          kind: 'err',
          text: `${booking.confirmationNo} is a ${booking.roomTypeCode}. Room ${room.number} is a ${room.roomTypeCode}.`,
        });
        return;
      }

      try {
        await assignRoom({
          variables: {
            input: { reservationRoomId: booking.reservationRoomId, roomId: room.id },
          },
        });
        await refetch();
        setToast({ kind: 'ok', text: `${booking.confirmationNo} → room ${room.number}` });
      } catch (err) {
        // The exclusion constraint speaks here: "Room 101 is already booked for
        // overlapping dates." Surfacing it verbatim is more useful than a generic
        // failure, because it tells the clerk exactly what is in the way.
        setToast({
          kind: 'err',
          text: err instanceof Error ? err.message : 'Could not assign that room',
        });
      }
    },
    [dragging, canAssign, assignRoom, refetch],
  );

  if (loading && !chart) return <p className="text-sm text-muted">Loading chart…</p>;
  if (error) {
    return (
      <div className="rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger">
        {error.message}
      </div>
    );
  }
  if (!chart) return null;

  const floors = [...new Set(chart.rooms.map((r) => r.floor ?? '—'))].sort();

  return (
    <>
      <PageHeader
        title="Tape chart"
        crumb="Operations"
        action={
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs outline-none focus:border-brand"
            />
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-lg border border-line bg-card px-2 py-1.5 text-xs outline-none focus:border-brand"
            >
              {[7, 14, 30, 60].map((d) => (
                <option key={d} value={d}>
                  {d} nights
                </option>
              ))}
            </select>
            <div className="flex overflow-hidden rounded-lg border border-line">
              <button
                onClick={() => setStart(addDays(start, -days))}
                className="bg-card px-2.5 py-1.5 text-xs text-muted hover:bg-canvas hover:text-ink"
              >
                ←
              </button>
              <button
                onClick={() => setStart(addDays(start, days))}
                className="border-l border-line bg-card px-2.5 py-1.5 text-xs text-muted hover:bg-canvas hover:text-ink"
              >
                →
              </button>
            </div>
          </div>
        }
      />

      <div className="space-y-4">

      {/* Unassigned tray. These bookings hold inventory but have no room yet —
          they are invisible on the grid, so they need somewhere to live. */}
      {chart.unassigned.length > 0 && (
        <div className="rounded-lg border border-dashed border-line p-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
            Unassigned · {chart.unassigned.length}
            {canAssign && <span className="ml-2 normal-case text-muted">drag onto a room</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            {chart.unassigned.map((u) => (
              <div
                key={u.reservationRoomId}
                draggable={canAssign}
                onDragStart={() => setDragging(u)}
                onDragEnd={() => setDragging(null)}
                className={`rounded px-2 py-1 text-xs ${canAssign ? 'cursor-grab active:cursor-grabbing' : ''} ${
                  RES_STATUS_STYLE[u.status] ?? 'bg-res-confirmed text-white'
                }`}
                title={`${u.guestName} · ${u.arrivalDate} → ${u.departureDate} · ${u.roomTypeCode}`}
              >
                <span className="font-medium">{u.guestName}</span>
                <span className="ml-1.5 opacity-80">{u.roomTypeCode}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && (
        <div
          role="status"
          className={`rounded-lg px-3 py-2 text-sm ${
            toast.kind === 'ok'
              ? 'bg-success-soft text-success'
              : 'bg-danger-soft text-danger'
          }`}
        >
          {toast.text}
          <button onClick={() => setToast(null)} className="ml-3 text-xs underline">
            dismiss
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-line">
        <div style={{ minWidth: 120 + chart.dates.length * CELL_W }}>
          {/* Date header */}
          <div className="flex border-b border-line bg-canvas">
            <div className="w-[120px] shrink-0 px-2 py-1 text-[10px] uppercase tracking-wide text-muted">
              Room
            </div>
            {chart.dates.map((d) => (
              <div
                key={d}
                style={{ width: CELL_W }}
                className={`shrink-0 border-l border-line/60 py-1 text-center text-[10px] tabular-nums ${
                  isWeekend(d) ? 'bg-canvas' : ''
                }`}
              >
                <div className="text-muted">{d.slice(8)}</div>
                <div className="text-muted/60">
                  {new Date(`${d}T00:00:00Z`).toLocaleDateString('en', {
                    weekday: 'narrow',
                    timeZone: 'UTC',
                  })}
                </div>
              </div>
            ))}
          </div>

          {floors.map((floor) => (
            <div key={floor}>
              <div className="border-b border-line/60 bg-canvas px-2 py-0.5 text-[10px] uppercase tracking-wide opacity-40 ">
                Floor {floor}
              </div>

              {chart.rooms
                .filter((r) => (r.floor ?? '—') === floor)
                .map((room) => {
                  const isTarget =
                    dragging !== null && dragging.roomTypeId === room.roomTypeId;
                  const isWrongType = dragging !== null && !isTarget;

                  return (
                    <div
                      key={room.id}
                      onDragOver={(e) => {
                        if (isTarget) e.preventDefault(); // allow drop
                      }}
                      onDrop={() => void onDrop(room)}
                      className={`flex border-b border-line/60 transition-colors ${
                        isTarget ? 'bg-success-soft' : ''
                      } ${isWrongType ? 'opacity-40' : ''}`}
                      style={{ height: ROW_H }}
                    >
                      <div className="flex w-[120px] shrink-0 items-center gap-1.5 px-2">
                        <span className="text-xs font-medium tabular-nums">{room.number}</span>
                        <span className="text-[10px] text-muted">{room.roomTypeCode}</span>
                        {(room.status === 'OOO' || room.status === 'OOS') && (
                          <span className="ml-auto rounded bg-danger-soft px-1 text-[9px] text-danger">
                            {room.status}
                          </span>
                        )}
                      </div>

                      <div
                        className="relative shrink-0"
                        style={{ width: chart.dates.length * CELL_W }}
                      >
                        {/* night gridlines */}
                        {chart.dates.map((d, i) => (
                          <div
                            key={d}
                            style={{ left: i * CELL_W, width: CELL_W }}
                            className={`absolute top-0 h-full border-l border-line/60 ${
                              isWeekend(d) ? 'bg-canvas' : ''
                            }`}
                          />
                        ))}

                        {(blocksByRoom.get(room.id) ?? []).map((b) => {
                          // Clip to the visible window — a stay may start before it.
                          const startOffset = Math.max(0, daysBetween(chart.from, b.arrivalDate));
                          const endOffset = Math.min(
                            chart.dates.length,
                            daysBetween(chart.from, b.departureDate),
                          );
                          const width = (endOffset - startOffset) * CELL_W;
                          if (width <= 0) return null;

                          return (
                            <div
                              key={b.reservationRoomId}
                              title={`${b.guestName} · ${b.confirmationNo}\n${b.arrivalDate} → ${b.departureDate}\n${b.status}`}
                              style={{
                                left: startOffset * CELL_W + 2,
                                width: width - 4,
                                top: 4,
                                height: ROW_H - 12,
                              }}
                              className={`absolute flex items-center overflow-hidden rounded px-1.5 text-[10px] font-medium shadow-sm ${
                                RES_STATUS_STYLE[b.status] ?? 'bg-res-confirmed text-white'
                              }`}
                            >
                              <span className="truncate">{b.guestName}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
            </div>
          ))}
        </div>
      </div>

        <div className="flex flex-wrap gap-2 text-[10px]">
          {Object.entries(RES_STATUS_STYLE).map(([status, cls]) => (
            <span key={status} className={`rounded px-1.5 py-0.5 ${cls}`}>
              {status.replace('_', ' ').toLowerCase()}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
