'use client';

import { useQuery } from '@apollo/client';
import Link from 'next/link';
import { useMemo } from 'react';
import { BarChart, Gauge, Sparkline } from '@/components/charts';
import { Icon } from '@/components/icons';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  StatCard,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { formatMinor } from '@/lib/money';
import { DAILY_REVENUE, OCCUPANCY, type DailyRevenue } from '@/lib/graphql/back-office';
import { FRONT_DESK_BOARD, type DeskRow } from '@/lib/graphql/front-desk';
import { ROOMS, STATUS_STYLE, type Room, type RoomStatus } from '@/lib/graphql/inventory';
import { CURRENT_PROPERTY, type Property } from '@/lib/graphql/operations';

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The overview.
 *
 * Role-aware by construction: a receptionist has no business seeing the hotel's
 * revenue, so those cards are not requested at all — not requested and hidden, but
 * never asked for. Rendering a wall of "Insufficient permissions" where the numbers
 * should be teaches people to ignore error messages.
 */
export default function DashboardPage() {
  const { user, role } = useAuth();

  const canSeeMoney = role === 'ADMIN' || role === 'MANAGER' || role === 'AUDITOR';

  const { data: prop } = useQuery<{ currentProperty: Property | null }>(CURRENT_PROPERTY);
  const property = prop?.currentProperty;
  const businessDate = property?.businessDate;
  const currency = property?.currency ?? 'INR';

  const { data: board } = useQuery<{
    frontDeskBoard: { arrivals: DeskRow[]; departures: DeskRow[]; inHouse: DeskRow[] };
  }>(FRONT_DESK_BOARD, { variables: { date: businessDate }, skip: !businessDate });

  const { data: roomData } = useQuery<{ rooms: Room[] }>(ROOMS);

  const { data: revenue } = useQuery<{ dailyRevenueReport: DailyRevenue }>(DAILY_REVENUE, {
    variables: { date: businessDate },
    skip: !businessDate || !canSeeMoney,
  });

  const { data: history } = useQuery<{
    occupancyReport: Array<{
      businessDate: string;
      occupancyBps: number;
      roomsSold: number;
      roomRevenueMinor: number;
      adrMinor: number;
      revparMinor: number;
    }>;
  }>(OCCUPANCY, {
    variables: { from: businessDate ? addDays(businessDate, -13) : '', to: businessDate ?? '' },
    skip: !businessDate || !canSeeMoney,
  });

  const arrivals = board?.frontDeskBoard.arrivals ?? [];
  const departures = board?.frontDeskBoard.departures ?? [];
  const inHouse = board?.frontDeskBoard.inHouse ?? [];
  const rooms = roomData?.rooms ?? [];
  const rev = revenue?.dailyRevenueReport;
  const trend = history?.occupancyReport ?? [];

  const roomCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rooms) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rooms]);

  const sellable = rooms.filter((r) => r.status !== 'OOO' && r.status !== 'OOS').length;
  const occupancyBps = sellable > 0 ? Math.round((inHouse.length / sellable) * 10_000) : 0;

  const unassigned = arrivals.filter((a) => !a.roomNumber).length;
  const owing = departures.filter((d) => d.balanceMinor > 0).length;

  return (
    <>
      <PageHeader title="Dashboard" crumb="General" />

      <div className="grid gap-5 lg:grid-cols-3">
        {/* ── Welcome ── */}
        <Card className="relative overflow-hidden bg-brand text-white lg:col-span-1" padded={false}>
          <div className="relative z-10 p-6">
            <p className="text-[13px] opacity-80">Welcome back</p>
            <h2 className="mt-0.5 text-xl font-semibold tracking-tight">{user?.name}</h2>

            <p className="mt-3 max-w-[240px] text-[13px] leading-relaxed opacity-90">
              {arrivals.length > 0
                ? `${arrivals.length} guest${arrivals.length > 1 ? 's' : ''} arriving today${
                    unassigned > 0 ? `, ${unassigned} still without a room.` : '.'
                  }`
                : 'No arrivals today.'}
            </p>

            <Link href="/front-desk">
              <Button className="mt-4 bg-white text-brand hover:bg-white/90">
                Open front desk
              </Button>
            </Link>

            <p className="mt-4 text-[11px] opacity-70">
              Business date {businessDate ?? '…'} · moves only at night audit
            </p>
          </div>

          {/* Decorative — never conveys information. */}
          <div className="absolute -bottom-10 -right-10 h-40 w-40 rounded-full bg-white/10" />
          <div className="absolute -right-4 top-6 h-24 w-24 rounded-full bg-white/5" />
        </Card>

        {/* ── Stats ── */}
        <div className="grid gap-5 sm:grid-cols-2 lg:col-span-2">
          <StatCard
            tone="brand"
            icon={<Icon.Desk className="h-6 w-6" />}
            label="Arrivals today"
            value={String(arrivals.length)}
            hint={unassigned > 0 ? `${unassigned} need a room assigned` : 'all rooms assigned'}
          />
          <StatCard
            tone="warning"
            icon={<Icon.Logout className="h-6 w-6" />}
            label="Departures today"
            value={String(departures.length)}
            hint={owing > 0 ? `${owing} still owe money` : 'all settled'}
          />
          <StatCard
            tone="success"
            icon={<Icon.Users className="h-6 w-6" />}
            label="In house"
            value={String(inHouse.length)}
            hint={`${sellable} sellable rooms`}
          />
          <StatCard
            tone="info"
            icon={<Icon.Bed className="h-6 w-6" />}
            label="Occupancy now"
            value={`${(occupancyBps / 100).toFixed(1)}%`}
            hint="live — frozen figure at night audit"
          />
        </div>
      </div>

      {/* ── Money (managers only) ── */}
      {canSeeMoney && rev && (
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="Occupancy · last 14 days"
              hint="frozen by the night audit — these do not move"
              action={
                <Badge tone="neutral">
                  {trend.length} night{trend.length === 1 ? '' : 's'}
                </Badge>
              }
            />

            {trend.length === 0 ? (
              <EmptyState>
                The night audit has not run yet, so no nights have been frozen.
              </EmptyState>
            ) : (
              <BarChart
                data={trend.map((t) => ({
                  label: t.businessDate.slice(8),
                  value: t.occupancyBps / 100,
                }))}
                format={(v) => `${v.toFixed(1)}%`}
              />
            )}
          </Card>

          <Card>
            <CardHeader title="Today" hint={rev.businessDate} />

            {rev.snapshot ? (
              <Gauge bps={rev.snapshot.occupancyBps} label="Occupancy (audited)" />
            ) : (
              <div className="py-3 text-center text-xs text-muted">
                Not yet audited — occupancy freezes tonight.
              </div>
            )}

            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-center">
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">Billed</p>
                <p className="mt-0.5 text-[13px] font-semibold tabular-nums">
                  {formatMinor(rev.grossRevenueMinor, currency)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">Collected</p>
                <p className="mt-0.5 text-[13px] font-semibold tabular-nums text-success">
                  {formatMinor(rev.paymentsMinor, currency)}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted">Owed</p>
                <p className="mt-0.5 text-[13px] font-semibold tabular-nums text-danger">
                  {formatMinor(rev.outstandingMinor, currency)}
                </p>
              </div>
            </div>

            {rev.snapshot && (
              <div className="mt-3 flex justify-between border-t border-line pt-3 text-xs">
                <span className="text-muted">
                  ADR{' '}
                  <strong className="font-semibold text-ink tabular-nums">
                    {formatMinor(rev.snapshot.adrMinor, currency)}
                  </strong>
                </span>
                <span className="text-muted">
                  RevPAR{' '}
                  <strong className="font-semibold text-ink tabular-nums">
                    {formatMinor(rev.snapshot.revparMinor, currency)}
                  </strong>
                </span>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── Rooms + arrivals ── */}
      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Room status"
            action={
              <Link href="/rooms" className="text-xs font-medium text-brand hover:underline">
                View board
              </Link>
            }
          />

          <div className="space-y-2.5">
            {(Object.keys(STATUS_STYLE) as RoomStatus[]).map((s) => {
              const n = roomCounts[s] ?? 0;
              const pct = rooms.length > 0 ? (n / rooms.length) * 100 : 0;

              return (
                <div key={s}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-muted">{STATUS_STYLE[s].label}</span>
                    <span className="font-medium tabular-nums">{n}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-line">
                    <div
                      style={{ width: `${pct}%`, backgroundColor: `var(--color-status-${slug(s)})` }}
                      className="h-full rounded-full transition-[width]"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {canSeeMoney && trend.length > 1 && (
            <div className="mt-4 border-t border-line pt-3">
              <p className="mb-1 text-[11px] uppercase tracking-wide text-muted">
                RevPAR trend
              </p>
              <Sparkline points={trend.map((t) => t.revparMinor)} />
            </div>
          )}
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Arrivals today"
            hint={businessDate}
            action={
              <Link href="/front-desk" className="text-xs font-medium text-brand hover:underline">
                Front desk
              </Link>
            }
          />

          {arrivals.length === 0 ? (
            <EmptyState>Nobody due to arrive today.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Guest</Th>
                  <Th>Room</Th>
                  <Th>Stay</Th>
                  <Th align="right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {arrivals.slice(0, 6).map((a) => (
                  <tr key={a.reservationRoomId}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand">
                          {a.guestName
                            .split(' ')
                            .map((p) => p[0])
                            .slice(0, 2)
                            .join('')}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium">{a.guestName}</p>
                          <p className="text-[11px] text-muted">{a.confirmationNo}</p>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      {a.roomNumber ? (
                        <span className="text-[13px] tabular-nums">{a.roomNumber}</span>
                      ) : (
                        <Badge tone="danger">unassigned</Badge>
                      )}
                      <span className="ml-1.5 text-[11px] text-muted">{a.roomTypeCode}</span>
                    </Td>
                    <Td className="text-[12px] tabular-nums text-muted">
                      {a.arrivalDate.slice(5)} → {a.departureDate.slice(5)}
                    </Td>
                    <Td align="right">
                      {a.roomNumber ? (
                        <Badge tone="success">ready</Badge>
                      ) : (
                        <Badge tone="warning">needs a room</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

/** VACANT_CLEAN → vacant-clean, so the token name resolves. */
function slug(status: string): string {
  return status.toLowerCase().replace('_', '-');
}
