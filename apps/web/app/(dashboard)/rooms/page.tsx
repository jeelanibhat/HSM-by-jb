'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Card, CardHeader, EmptyState, Input, PageHeader, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
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
 * simply has no "out of order" button to press, rather than showing one and failing
 * on submit. Same rule, one definition, and the screen cannot drift from it.
 */
export default function RoomsPage() {
  const { role } = useAuth();
  const { data, loading, error } = useQuery<{ rooms: Room[]; roomTypes: RoomType[] }>(ROOMS);
  const [selected, setSelected] = useState<Room | null>(null);
  const [filter, setFilter] = useState<RoomStatus | 'ALL'>('ALL');

  const canEdit = role !== 'AUDITOR';

  if (loading && !data) return <Spinner label="Loading rooms…" />;
  if (error) return <Alert tone="danger">{error.message}</Alert>;

  const rooms = data?.rooms ?? [];
  const typeById = new Map((data?.roomTypes ?? []).map((t) => [t.id, t]));

  if (rooms.length === 0) {
    return (
      <>
        <PageHeader title="Rooms" crumb="Operations" />
        <EmptyState>
          This property has no rooms yet. A manager can add room types and rooms in settings.
        </EmptyState>
      </>
    );
  }

  const counts = rooms.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  const shown = filter === 'ALL' ? rooms : rooms.filter((r) => r.status === filter);
  const floors = [...new Set(shown.map((r) => r.floor ?? '—'))].sort();

  return (
    <>
      <PageHeader title="Rooms" crumb="Operations" />

      {/* Status filter doubles as the legend. Clicking a count filters to it. */}
      <div className="mb-5 flex flex-wrap gap-2">
        <button
          onClick={() => setFilter('ALL')}
          className={cn(
            'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
            filter === 'ALL'
              ? 'border-brand bg-brand text-white'
              : 'border-line bg-card text-muted hover:text-ink',
          )}
        >
          All <span className="ml-1 tabular-nums opacity-80">{rooms.length}</span>
        </button>

        {(Object.keys(STATUS_STYLE) as RoomStatus[]).map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors',
              filter === s ? STATUS_STYLE[s].className : 'border-line bg-card text-muted hover:text-ink',
            )}
          >
            {STATUS_STYLE[s].label}
            <span className="ml-1 tabular-nums opacity-80">{counts[s] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="space-y-5">
        {floors.map((floor) => (
          <Card key={floor}>
            <CardHeader title={`Floor ${floor}`} />

            <div className="grid grid-cols-[repeat(auto-fill,minmax(92px,1fr))] gap-2.5">
              {shown
                .filter((r) => (r.floor ?? '—') === floor)
                .map((room) => {
                  const locked = !canEdit || room.allowedTransitions.length === 0;

                  return (
                    <button
                      key={room.id}
                      onClick={() => !locked && setSelected(room)}
                      disabled={locked}
                      title={
                        room.allowedTransitions.length === 0
                          ? 'Occupied — check the guest out to change this room'
                          : undefined
                      }
                      className={cn(
                        'rounded-lg border px-2.5 py-3 text-left transition-all',
                        STATUS_STYLE[room.status].className,
                        locked
                          ? 'cursor-not-allowed opacity-70'
                          : 'hover:-translate-y-0.5 hover:shadow-card',
                      )}
                    >
                      <div className="flex items-baseline justify-between">
                        <span className="text-[15px] font-semibold tabular-nums">
                          {room.number}
                        </span>
                        <span className="text-[10px] opacity-70">
                          {typeById.get(room.roomTypeId)?.code ?? ''}
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] font-medium leading-tight opacity-90">
                        {STATUS_STYLE[room.status].short}
                      </p>
                    </button>
                  );
                })}
            </div>
          </Card>
        ))}
      </div>

      {selected && <StatusDialog room={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function StatusDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const [status, setStatus] = useState<RoomStatus | ''>('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const [update, { loading }] = useMutation(UPDATE_ROOM_STATUS, {
    // The room board, the tape chart and availability all read this room. Refetching
    // is cheap and correct; hand-patching the cache is where cross-screen staleness
    // creeps in.
    refetchQueries: ['Rooms'],
  });

  // Taking a room out of order strands a guest if it is a mistake — make the person
  // say why. It lands in the audit log (TDD §7.4).
  const needsReason = status === 'OOO' || status === 'OOS';

  const submit = async () => {
    if (!status) return;
    setErr(null);

    try {
      await update({
        variables: { input: { roomId: room.id, status, reason: reason.trim() || undefined } },
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update the room');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={`Change status of room ${room.number}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-card border border-line bg-card p-5 shadow-pop"
      >
        <h2 className="text-base font-semibold">Room {room.number}</h2>
        <p className="mt-0.5 text-xs text-muted">
          Currently {STATUS_STYLE[room.status].label.toLowerCase()}
        </p>

        <div className="mt-4 space-y-2">
          {/* Only the transitions the server says are legal. An occupied room has
              none, so this list is empty and the tile was never clickable. */}
          {room.allowedTransitions.map((s) => (
            <label
              key={s}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                status === s ? STATUS_STYLE[s].className : 'border-line hover:bg-canvas',
              )}
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
            <Input
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason — recorded in the audit log"
            />
          </div>
        )}

        {err && (
          <div className="mt-3">
            <Alert tone="danger">{err}</Alert>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={!status || loading || (needsReason && reason.trim().length === 0)}
          >
            {loading ? 'Saving…' : 'Update'}
          </Button>
        </div>
      </div>
    </div>
  );
}
