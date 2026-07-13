'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Spinner,
} from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { cn } from '@/lib/cn';
import {
  ASSIGN_TASK,
  ATTENDANTS,
  COMPLETE_TASK,
  GENERATE_BOARD,
  HOUSEKEEPING_BOARD,
  INSPECT_TASK,
  START_TASK,
  type Attendant,
  type HousekeepingTask,
  type HousekeepingTaskStatus,
} from '@/lib/graphql/housekeeping';

const STATUS_STYLE: Record<HousekeepingTaskStatus, { label: string; cls: string }> = {
  PENDING: { label: 'To do', cls: 'bg-danger-soft text-danger' },
  IN_PROGRESS: { label: 'Cleaning', cls: 'bg-warning-soft text-warning' },
  DONE: { label: 'Cleaned', cls: 'bg-brand-50 text-brand' },
  INSPECTED: { label: 'Inspected', cls: 'bg-success-soft text-success' },
};

const TYPE_LABEL: Record<string, string> = {
  DEPARTURE: 'Departure',
  STAYOVER: 'Stayover',
  DEEP_CLEAN: 'Deep clean',
  TURNDOWN: 'Turndown',
};

/**
 * The housekeeping board.
 *
 * The distinction this screen exists to make visible is DONE vs INSPECTED. "Cleaned"
 * is an attendant's word for it; "Inspected" means a supervisor looked. They are shown
 * as different things, in different colours, because a hotel that treats them as the
 * same one sells rooms on somebody's say-so.
 *
 * A failed inspection is not an error state — it is the system working. The room goes
 * back to dirty, the task reappears as "To do", and the reason is printed on the card
 * where the attendant will see it.
 */
export default function HousekeepingPage() {
  const { role, user } = useAuth();

  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [failing, setFailing] = useState<HousekeepingTask | null>(null);

  const isSupervisor = role === 'ADMIN' || role === 'MANAGER';
  const mayClean = isSupervisor || role === 'HOUSEKEEPING';

  const { data, loading, error, refetch } = useQuery<{ housekeepingBoard: HousekeepingTask[] }>(
    HOUSEKEEPING_BOARD,
    { fetchPolicy: 'cache-and-network' },
  );

  const { data: staff } = useQuery<{ housekeepingAttendants: Attendant[] }>(ATTENDANTS, {
    skip: !isSupervisor,
  });

  /**
   * Run a mutation, refetch, and say what happened.
   *
   * The message comes BACK from `fn` rather than being set inside it: an earlier
   * version let the callback call setBanner itself, and then overwrote it here a
   * moment later — so the one message that varied ("Raised 4 tasks" / "already up to
   * date") was silently replaced with an empty banner.
   */
  const run = async (fn: () => Promise<string>) => {
    setBanner(null);
    try {
      const text = await fn();
      await refetch();
      setBanner({ tone: 'success', text });
    } catch (e) {
      setBanner({ tone: 'danger', text: e instanceof Error ? e.message : 'That did not work' });
    }
  };

  const [generate, { loading: generating }] = useMutation(GENERATE_BOARD);
  const [assign] = useMutation(ASSIGN_TASK);
  const [start] = useMutation(START_TASK);
  const [complete] = useMutation(COMPLETE_TASK);
  const [inspect] = useMutation(INSPECT_TASK);

  if (loading && !data) return <Spinner label="Loading the board…" />;
  if (error) return <Alert tone="danger">{error.message}</Alert>;

  const tasks = data?.housekeepingBoard ?? [];

  const counts = tasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1;
    return acc;
  }, {});

  const outstanding = tasks.filter((t) => t.status !== 'INSPECTED');
  const workLeft = outstanding.reduce((sum, t) => sum + t.credits, 0);

  // Floors, in order, so an attendant walks the building rather than the alphabet.
  const floors = [...new Set(tasks.map((t) => t.roomFloor ?? '—'))].sort();

  return (
    <>
      <PageHeader title="Housekeeping" crumb="Operations" />

      <div className="space-y-5">
        {banner && (
          <Alert tone={banner.tone} onDismiss={() => setBanner(null)}>
            {banner.text}
          </Alert>
        )}

        {/* ── The day at a glance ── */}
        <div className="flex flex-wrap items-center gap-3">
          {(['PENDING', 'IN_PROGRESS', 'DONE', 'INSPECTED'] as const).map((s) => (
            <Card key={s} className="flex-1 min-w-[8rem] py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                {STATUS_STYLE[s].label}
              </p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums">{counts[s] ?? 0}</p>
            </Card>
          ))}

          <Card className="flex-1 min-w-[8rem] py-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
              Work left
            </p>
            {/* Credits, not room count: eight departures is not eight turndowns. */}
            <p className="mt-0.5 text-2xl font-semibold tabular-nums">
              {Math.round(workLeft / 60)}
              <span className="ml-1 text-sm font-normal text-muted">hrs</span>
            </p>
          </Card>
        </div>

        {isSupervisor && (
          <div className="flex items-center gap-3">
            <Button
              onClick={() =>
                void run(async () => {
                  const res = await generate({ variables: { input: {} } });
                  const n = res.data.generateHousekeepingBoard.created;

                  return n === 0
                    ? 'The board is already up to date — nothing new to raise.'
                    : `Raised ${n} task${n === 1 ? '' : 's'}.`;
                })
              }
              disabled={generating}
            >
              {generating ? 'Building…' : 'Generate today’s board'}
            </Button>

            <p className="text-xs text-muted">
              Safe to press twice — it will not duplicate work or reset anything underway.
            </p>
          </div>
        )}

        {tasks.length === 0 ? (
          <EmptyState>
            Nothing on the board for today.
            {isSupervisor
              ? ' Generate it from the departures and stayovers.'
              : ' A supervisor generates it each morning.'}
          </EmptyState>
        ) : (
          floors.map((floor) => {
            const rows = tasks.filter((t) => (t.roomFloor ?? '—') === floor);

            return (
              <section key={floor} className="space-y-2">
                <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  Floor {floor} · {rows.length} room{rows.length === 1 ? '' : 's'}
                </h2>

                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {rows.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      isSupervisor={isSupervisor}
                      mayClean={mayClean}
                      mine={task.assignedTo === user?.id}
                      attendants={staff?.housekeepingAttendants ?? []}
                      onStart={() =>
                        void run(async () => {
                          await start({ variables: { input: { taskId: task.id } } });
                          return `Room ${task.roomNumber} — started.`;
                        })
                      }
                      onComplete={() =>
                        void run(async () => {
                          await complete({ variables: { input: { taskId: task.id } } });
                          return `Room ${task.roomNumber} cleaned.`;
                        })
                      }
                      onPass={() =>
                        void run(async () => {
                          await inspect({
                            variables: { input: { taskId: task.id, passed: true } },
                          });
                          return `Room ${task.roomNumber} inspected and ready to sell.`;
                        })
                      }
                      onFail={() => setFailing(task)}
                      onAssign={(userId) =>
                        void run(async () => {
                          await assign({
                            variables: { input: { taskId: task.id, assignedTo: userId } },
                          });
                          return `Room ${task.roomNumber} reassigned.`;
                        })
                      }
                    />
                  ))}
                </div>
              </section>
            );
          })
        )}
      </div>

      {failing && (
        <FailDialog
          task={failing}
          onCancel={() => setFailing(null)}
          onConfirm={(reason) => {
            setFailing(null);
            void run(async () => {
              await inspect({
                variables: { input: { taskId: failing.id, passed: false, reason } },
              });
              return `Room ${failing.roomNumber} sent back — it is dirty again and back on the board.`;
            });
          }}
        />
      )}
    </>
  );
}

function TaskCard({
  task,
  isSupervisor,
  mayClean,
  mine,
  attendants,
  onStart,
  onComplete,
  onPass,
  onFail,
  onAssign,
}: {
  task: HousekeepingTask;
  isSupervisor: boolean;
  mayClean: boolean;
  mine: boolean;
  attendants: Attendant[];
  onStart: () => void;
  onComplete: () => void;
  onPass: () => void;
  onFail: () => void;
  onAssign: (userId: string | null) => void;
}) {
  const style = STATUS_STYLE[task.status];

  /**
   * An attendant may work an unassigned room or their own. Somebody else's room shows
   * no buttons at all — rather than offering them and failing on submit. (The server
   * refuses either way; this is just not lying to the user about what they can do.)
   */
  const canWorkIt = isSupervisor || (mayClean && (task.assignedTo === null || mine));

  return (
    <Card label={`Room ${task.roomNumber}`} className="space-y-3">
      <div className="flex items-start gap-2">
        <div>
          <p className="text-lg font-semibold tabular-nums">{task.roomNumber}</p>
          <p className="text-xs text-muted">
            {task.roomTypeCode} · {TYPE_LABEL[task.type] ?? task.type} · {task.credits} min
          </p>
        </div>

        <span
          className={cn(
            'ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium',
            style.cls,
          )}
        >
          {style.label}
        </span>
      </div>

      {/* The room's own status, next to the task's. When they disagree, say so. */}
      <p className="text-xs text-muted">
        Room is{' '}
        <span className="font-medium text-ink">
          {task.roomStatus.replace('_', ' ').toLowerCase()}
        </span>
        {task.assigneeName && (
          <>
            {' · '}
            <span className={cn(mine && 'font-medium text-brand')}>
              {mine ? 'You' : task.assigneeName}
            </span>
          </>
        )}
      </p>

      {task.inspectionNote && task.status === 'PENDING' && (
        // The attendant is owed a reason. "Failed" on its own is not actionable.
        <p className="rounded bg-danger-soft px-2 py-1.5 text-xs text-danger">
          Sent back: {task.inspectionNote}
          {task.failedInspections > 1 && ` (${task.failedInspections}× )`}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canWorkIt && task.status === 'PENDING' && (
          <Button size="sm" variant="outline" onClick={onStart}>
            Start
          </Button>
        )}

        {canWorkIt && (task.status === 'PENDING' || task.status === 'IN_PROGRESS') && (
          <Button size="sm" onClick={onComplete}>
            Mark clean
          </Button>
        )}

        {isSupervisor && task.status === 'DONE' && (
          <>
            <Button size="sm" onClick={onPass}>
              Pass
            </Button>
            <Button size="sm" variant="outline" onClick={onFail}>
              Send back
            </Button>
          </>
        )}

        {isSupervisor && task.status !== 'INSPECTED' && (
          <select
            aria-label={`Assign room ${task.roomNumber}`}
            value={task.assignedTo ?? ''}
            onChange={(e) => onAssign(e.target.value === '' ? null : e.target.value)}
            className="ml-auto rounded-lg border border-line bg-transparent px-2 py-1 text-xs outline-none focus:border-brand"
          >
            <option value="">Unassigned</option>
            {attendants.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </Card>
  );
}

/** Failing an inspection sends someone back to a room. Say why. */
function FailDialog({
  task,
  onCancel,
  onConfirm,
}: {
  task: HousekeepingTask;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-label={`Send room ${task.roomNumber} back`}
        className="w-full max-w-sm space-y-4 rounded-xl bg-surface p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-base font-semibold">Send room {task.roomNumber} back</h2>
          <p className="mt-1 text-xs text-muted">
            The room goes back to dirty and returns to the board. It cannot be sold until it
            passes.
          </p>
        </div>

        <label className="block">
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted">
            What is wrong with it?
          </span>
          <input
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Bathroom not touched"
            className="w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </label>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(reason.trim())} disabled={reason.trim() === ''}>
            Send back
          </Button>
        </div>
      </div>
    </div>
  );
}
