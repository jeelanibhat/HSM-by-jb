'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import {
  ROOMS,
  STATUS_STYLE,
  UPDATE_ROOM_STATUS,
  type Room,
  type RoomStatus,
  type RoomType,
} from '@/lib/graphql/inventory';

/**
 * Room status board — the housekeeping and maintenance surface.
 *
 * The status options offered for a room come from `allowedTransitions`, computed
 * SERVER-side by the domain machine. The UI never derives them: an occupied room
 * simply has no "out of order" button to press, rather than showing one and
 * failing on submit. Same rule, one definition, and the screen cannot drift from it.
 */
export default function RoomsPage() {
  const { role } = useAuth();
  const { data, loading, error } = useQuery<{ rooms: Room[]; roomTypes: RoomType[] }>(ROOMS);
  const [selected, setSelected] = useState<Room | null>(null);

  const canEdit = role !== 'AUDITOR';

  if (loading) return <p className="text-sm opacity-60">Loading rooms…</p>;
  if (error) {
    return (
      <div className="rounded-md bg-status-ooo/10 px-4 py-3 text-sm text-status-ooo">
        {error.message}
      </div>
    );
  }

  const rooms = data?.rooms ?? [];
  const typeById = new Map((data?.roomTypes ?? []).map((t) => [t.id, t]));

  if (rooms.length === 0) {
    return (
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">Rooms</h1>
        <p className="text-sm opacity-60">
          This property has no rooms yet. A manager can add room types and rooms in settings.
        </p>
      </div>
    );
  }

  const counts = rooms.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  const floors = [...new Set(rooms.map((r) => r.floor ?? '—'))].sort();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Rooms</h1>
        <p className="mt-1 text-sm opacity-60">{rooms.length} rooms</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {(Object.keys(STATUS_STYLE) as RoomStatus[]).map((s) => (
          <span
            key={s}
            className={`rounded border px-2 py-1 text-xs ${STATUS_STYLE[s].className}`}
          >
            {STATUS_STYLE[s].label} · <strong>{counts[s] ?? 0}</strong>
          </span>
        ))}
      </div>

      {floors.map((floor) => (
        <section key={floor}>
          <h2 className="mb-2 text-xs uppercase tracking-wide opacity-50">Floor {floor}</h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
            {rooms
              .filter((r) => (r.floor ?? '—') === floor)
              .map((room) => (
                <button
                  key={room.id}
                  onClick={() => canEdit && setSelected(room)}
                  disabled={!canEdit || room.allowedTransitions.length === 0}
                  title={
                    room.allowedTransitions.length === 0
                      ? 'Occupied — check the guest out to change this room'
                      : undefined
                  }
                  className={`rounded-md border px-2 py-3 text-left transition-opacity enabled:hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60 ${
                    STATUS_STYLE[room.status].className
                  }`}
                >
                  <div className="text-sm font-semibold tabular-nums">{room.number}</div>
                  <div className="mt-0.5 text-[10px] opacity-80">
                    {typeById.get(room.roomTypeId)?.code ?? ''}
                  </div>
                  <div className="mt-1 text-[10px] leading-tight opacity-90">
                    {STATUS_STYLE[room.status].label}
                  </div>
                </button>
              ))}
          </div>
        </section>
      ))}

      {selected && <StatusDialog room={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function StatusDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const [status, setStatus] = useState<RoomStatus | ''>('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const [update, { loading }] = useMutation(UPDATE_ROOM_STATUS, {
    // The room-status board, the tape chart and availability all read this room.
    // Refetching is cheap and correct; hand-patching the cache is where staleness
    // and cross-screen disagreement creep in.
    refetchQueries: ['Rooms'],
  });

  // Taking a room out of order strands a guest if it is a mistake — make the
  // person say why. It lands in the audit log (TDD §7.4).
  const needsReason = status === 'OOO' || status === 'OOS';

  const submit = async () => {
    if (!status) return;
    setErr(null);

    try {
      await update({
        variables: {
          input: { roomId: room.id, status, reason: reason.trim() || undefined },
        },
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update the room');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`Change status of room ${room.number}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-lg border border-black/10 bg-[var(--background)] p-5 shadow-xl dark:border-white/15"
      >
        <h2 className="text-base font-semibold">Room {room.number}</h2>
        <p className="mt-1 text-xs opacity-60">
          Currently {STATUS_STYLE[room.status].label.toLowerCase()}
        </p>

        <div className="mt-4 space-y-2">
          {/* Only the transitions the server says are legal. An occupied room has
              none, so this list is empty and the button was never clickable. */}
          {room.allowedTransitions.map((s) => (
            <label
              key={s}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                status === s ? STATUS_STYLE[s].className : 'border-black/10 dark:border-white/15'
              }`}
            >
              <input
                type="radio"
                name="status"
                value={s}
                checked={status === s}
                onChange={() => setStatus(s)}
                className="accent-current"
              />
              {STATUS_STYLE[s].label}
            </label>
          ))}
        </div>

        {needsReason && (
          <div className="mt-3">
            <label htmlFor="reason" className="mb-1 block text-xs font-medium">
              Reason <span className="opacity-60">(recorded in the audit log)</span>
            </label>
            <input
              id="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Leaking shower"
              className="w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none dark:border-white/20"
            />
          </div>
        )}

        {err && (
          <p role="alert" className="mt-3 rounded bg-status-ooo/10 px-3 py-2 text-xs text-status-ooo">
            {err}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 text-sm opacity-70 hover:opacity-100">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!status || loading || (needsReason && reason.trim().length === 0)}
            className="rounded-md bg-status-occupied px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? 'Saving…' : 'Update'}
          </button>
        </div>
      </div>
    </div>
  );
}
