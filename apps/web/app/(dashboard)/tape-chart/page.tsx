'use client';

import { useMutation, useQuery, useSubscription } from '@apollo/client';
import { useCallback, useMemo, useState } from 'react';
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

  if (loading && !chart) return <p className="text-sm opacity-60">Loading chart…</p>;
  if (error) {
    return (
      <div className="rounded-md bg-status-ooo/10 px-4 py-3 text-sm text-status-ooo">
        {error.message}
      </div>
    );
  }
  if (!chart) return null;

  const floors = [...new Set(chart.rooms.map((r) => r.floor ?? '—'))].sort();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Tape chart</h1>
          <p className="mt-1 text-sm opacity-60">
            {chart.rooms.length} rooms · {chart.dates.length} nights
          </p>
        </div>

        <div className="ml-auto flex items-end gap-2">
          <label className="text-xs">
            <span className="mb-1 block opacity-60">From</span>
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            />
          </label>
          <label className="text-xs">
            <span className="mb-1 block opacity-60">Nights</span>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20"
            >
              {[7, 14, 30, 60].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => setStart(addDays(start, -days))}
            className="rounded-md border border-black/15 px-2 py-1 text-sm dark:border-white/20"
          >
            ←
          </button>
          <button
            onClick={() => setStart(addDays(start, days))}
            className="rounded-md border border-black/15 px-2 py-1 text-sm dark:border-white/20"
          >
            →
          </button>
        </div>
      </div>

      {/* Unassigned tray. These bookings hold inventory but have no room yet —
          they are invisible on the grid, so they need somewhere to live. */}
      {chart.unassigned.length > 0 && (
        <div className="rounded-md border border-dashed border-black/20 p-3 dark:border-white/20">
          <p className="mb-2 text-xs uppercase tracking-wide opacity-50">
            Unassigned · {chart.unassigned.length}
            {canAssign && <span className="ml-2 normal-case opacity-70">drag onto a room</span>}
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
          className={`rounded-md px-3 py-2 text-sm ${
            toast.kind === 'ok'
              ? 'bg-status-vacant-clean/15 text-status-vacant-clean'
              : 'bg-status-ooo/15 text-status-ooo'
          }`}
        >
          {toast.text}
          <button onClick={() => setToast(null)} className="ml-3 text-xs underline">
            dismiss
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-black/10 dark:border-white/10">
        <div style={{ minWidth: 120 + chart.dates.length * CELL_W }}>
          {/* Date header */}
          <div className="flex border-b border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.03]">
            <div className="w-[120px] shrink-0 px-2 py-1 text-[10px] uppercase tracking-wide opacity-50">
              Room
            </div>
            {chart.dates.map((d) => (
              <div
                key={d}
                style={{ width: CELL_W }}
                className={`shrink-0 border-l border-black/5 py-1 text-center text-[10px] tabular-nums dark:border-white/5 ${
                  isWeekend(d) ? 'bg-black/[0.03] dark:bg-white/[0.05]' : ''
                }`}
              >
                <div className="opacity-50">{d.slice(8)}</div>
                <div className="opacity-30">
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
              <div className="border-b border-black/5 bg-black/[0.02] px-2 py-0.5 text-[10px] uppercase tracking-wide opacity-40 dark:border-white/5 dark:bg-white/[0.03]">
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
                      className={`flex border-b border-black/5 transition-colors dark:border-white/5 ${
                        isTarget ? 'bg-status-vacant-clean/10' : ''
                      } ${isWrongType ? 'opacity-40' : ''}`}
                      style={{ height: ROW_H }}
                    >
                      <div className="flex w-[120px] shrink-0 items-center gap-1.5 px-2">
                        <span className="text-xs font-medium tabular-nums">{room.number}</span>
                        <span className="text-[10px] opacity-40">{room.roomTypeCode}</span>
                        {(room.status === 'OOO' || room.status === 'OOS') && (
                          <span className="ml-auto rounded bg-status-ooo/20 px-1 text-[9px] text-status-ooo">
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
                            className={`absolute top-0 h-full border-l border-black/5 dark:border-white/5 ${
                              isWeekend(d) ? 'bg-black/[0.02] dark:bg-white/[0.03]' : ''
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
  );
}
