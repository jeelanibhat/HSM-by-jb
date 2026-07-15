'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import { Alert, Button, Card, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { formatMinor, formatMinorPlain } from '@/lib/money';
import {
  ADD_LINE,
  CHARGE_TO_ROOM,
  MENU,
  OPEN_ORDER,
  OPEN_ORDERS,
  POS_SETUP,
  REMOVE_LINE,
  VOID_ORDER,
  type ChargeableRoom,
  type MenuItem,
  type Outlet,
  type PosOrder,
} from '@/lib/graphql/pos';

/**
 * The till.
 *
 * Two things this screen deliberately does NOT do:
 *
 *   1. It never prices anything. Tapping a dish sends its id; the server looks up what
 *      a dal costs. A POS whose client names the price is a POS that can sell a bottle
 *      of wine for one rupee.
 *
 *   2. It never shows a guest's balance. The waiter picks a room from a list of people
 *      who are actually staying, sees a NAME, and sends the order. What else is on that
 *      bill is between the guest and the front desk. The server does not send it, so
 *      there is nothing here to accidentally render.
 *
 * The tax is likewise absent: it is added by the folio, from the property's
 * configuration, at the moment of posting. The subtotal shown here is what the meal
 * costs, and the guest's bill will show the GST as its own line.
 */
export default function PosPage() {
  const [outletId, setOutletId] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [charging, setCharging] = useState(false);

  const { data: setup, loading, error, refetch: refetchSetup } = useQuery<{
    outlets: Outlet[];
    chargeableRooms: ChargeableRoom[];
  }>(POS_SETUP, { fetchPolicy: 'cache-and-network' });

  const outlets = setup?.outlets ?? [];
  const activeOutlet = outletId || outlets[0]?.id || '';

  const { data: menuData } = useQuery<{ menu: MenuItem[] }>(MENU, {
    variables: { outletId: activeOutlet },
    skip: !activeOutlet,
  });

  const { data: ordersData, refetch: refetchOrders } = useQuery<{ openOrders: PosOrder[] }>(
    OPEN_ORDERS,
    { variables: { outletId: activeOutlet }, skip: !activeOutlet, fetchPolicy: 'cache-and-network' },
  );

  const [openOrder] = useMutation(OPEN_ORDER);
  const [addLine] = useMutation(ADD_LINE);
  const [removeLine] = useMutation(REMOVE_LINE);
  const [chargeToRoom] = useMutation(CHARGE_TO_ROOM);
  const [voidOrder] = useMutation(VOID_ORDER);

  const orders = ordersData?.openOrders ?? [];
  const order = orders.find((o) => o.id === orderId) ?? null;

  const run = async (fn: () => Promise<string>) => {
    setBanner(null);
    try {
      const text = await fn();
      await Promise.all([refetchOrders(), refetchSetup()]);
      if (text) setBanner({ tone: 'success', text });
    } catch (e) {
      setBanner({ tone: 'danger', text: e instanceof Error ? e.message : 'That did not work' });
    }
  };

  if (loading && !setup) return <Spinner label="Opening the till…" />;
  if (error) return <Alert tone="danger">{error.message}</Alert>;

  if (outlets.length === 0) {
    return (
      <>
        <PageHeader title="Point of sale" crumb="Operations" />
        <EmptyState>This property has no outlets yet.</EmptyState>
      </>
    );
  }

  const menu = menuData?.menu ?? [];
  const categories = [...new Set(menu.map((m) => m.category ?? 'Other'))];
  const rooms = setup?.chargeableRooms ?? [];

  return (
    <>
      <PageHeader title="Point of sale" crumb="Operations" />

      <div className="space-y-5">
        {banner && (
          <Alert tone={banner.tone} onDismiss={() => setBanner(null)}>
            {banner.text}
          </Alert>
        )}

        {/* ── Outlet ── */}
        <div className="flex flex-wrap items-center gap-2">
          {outlets.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                setOutletId(o.id);
                setOrderId(null);
              }}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                activeOutlet === o.id
                  ? 'border-brand bg-brand text-white'
                  : 'border-line hover:border-brand hover:text-brand'
              }`}
            >
              {o.name}
            </button>
          ))}

          <Button
            className="ml-auto"
            onClick={() =>
              void run(async () => {
                const res = await openOrder({
                  variables: { input: { outletId: activeOutlet } },
                });
                setOrderId(res.data.openOrder.id);
                return `Order ${res.data.openOrder.orderNo} opened.`;
              })
            }
          >
            New order
          </Button>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          {/* ── Menu ── */}
          <div className="space-y-4 lg:col-span-2">
            {!order && (
              <EmptyState>
                {orders.length > 0
                  ? 'Pick an open order on the right, or start a new one.'
                  : 'Start a new order to take one.'}
              </EmptyState>
            )}

            {order &&
              categories.map((category) => (
                <section key={category} className="space-y-2">
                  <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    {category}
                  </h2>

                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {menu
                      .filter((m) => (m.category ?? 'Other') === category)
                      .map((item) => (
                        <button
                          key={item.id}
                          onClick={() =>
                            void run(async () => {
                              await addLine({
                                variables: {
                                  input: { orderId: order.id, menuItemId: item.id, quantity: 1 },
                                },
                              });
                              return '';
                            })
                          }
                          className="flex items-center justify-between rounded-lg border border-line bg-card px-3 py-2.5 text-left text-sm transition-colors hover:border-brand hover:text-brand"
                        >
                          <span className="font-medium">{item.name}</span>
                          <span className="tabular-nums text-muted">
                            {formatMinorPlain(item.priceMinor)}
                          </span>
                        </button>
                      ))}
                  </div>
                </section>
              ))}
          </div>

          {/* ── The tab ── */}
          <div className="space-y-4">
            {orders.length > 0 && (
              <Card>
                <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                  Open orders
                </h2>

                <div className="space-y-1">
                  {orders.map((o) => (
                    <button
                      key={o.id}
                      onClick={() => setOrderId(o.id)}
                      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-sm transition-colors ${
                        o.id === orderId ? 'bg-brand-50 text-brand' : 'hover:bg-canvas'
                      }`}
                    >
                      <span className="font-medium tabular-nums">{o.orderNo}</span>
                      <span className="tabular-nums text-muted">
                        {formatMinorPlain(o.subtotalMinor)}
                      </span>
                    </button>
                  ))}
                </div>
              </Card>
            )}

            {order && (
              <Card label={`Order ${order.orderNo}`} className="space-y-3">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-base font-semibold tabular-nums">{order.orderNo}</h2>
                  {order.tableRef && (
                    <span className="text-xs text-muted">{order.tableRef}</span>
                  )}
                </div>

                {order.lines.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted">
                    Tap the menu to add something.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {order.lines.map((l) => (
                      <div
                        key={l.id}
                        className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm hover:bg-canvas"
                      >
                        <span className="w-6 shrink-0 tabular-nums text-muted">{l.quantity}×</span>
                        <span className="min-w-0 flex-1 truncate">{l.description}</span>
                        <span className="tabular-nums">
                          {formatMinorPlain(l.unitPriceMinor * l.quantity)}
                        </span>
                        <button
                          aria-label={`Remove ${l.description}`}
                          onClick={() =>
                            void run(async () => {
                              await removeLine({
                                variables: { input: { orderId: order.id, lineId: l.id } },
                              });
                              return '';
                            })
                          }
                          className="shrink-0 rounded px-1 text-xs text-muted hover:bg-danger-soft hover:text-danger"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex justify-between border-t border-line pt-2 text-base font-semibold tabular-nums">
                  <span>Subtotal</span>
                  <span>{formatMinor(order.subtotalMinor, 'INR')}</span>
                </div>

                {/* Say where the tax is, rather than leaving the waiter to wonder. */}
                <p className="text-[11px] text-muted">
                  GST is added to the guest’s bill when this is posted.
                </p>

                {/* ── Send it to a room ── */}
                <div className="space-y-2 border-t border-line pt-3">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    Charge to room
                  </p>

                  {rooms.length === 0 ? (
                    <p className="text-xs text-muted">Nobody is checked in.</p>
                  ) : (
                    <div className="space-y-1">
                      {rooms.map((r) => (
                        <button
                          key={r.roomId}
                          disabled={order.lines.length === 0 || charging}
                          onClick={() =>
                            void (async () => {
                              setCharging(true);
                              await run(async () => {
                                const res = await chargeToRoom({
                                  variables: {
                                    input: { orderId: order.id, roomId: r.roomId },
                                  },
                                });
                                setOrderId(null);

                                const { roomNumber, chargedMinor } = res.data.chargeOrderToRoom;
                                return `${formatMinor(chargedMinor, 'INR')} charged to room ${roomNumber}.`;
                              });
                              setCharging(false);
                            })()
                          }
                          className="flex w-full items-center justify-between rounded-lg border border-line px-2.5 py-2 text-sm transition-colors hover:border-brand hover:text-brand disabled:opacity-40"
                        >
                          <span className="font-medium tabular-nums">{r.roomNumber}</span>
                          {/* A name — enough to say "Mr Sharma?" and be sure. Nothing more. */}
                          <span className="truncate text-xs text-muted">{r.guestName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() =>
                    void run(async () => {
                      await voidOrder({
                        variables: { input: { orderId: order.id, reason: 'Cancelled at the till' } },
                      });
                      setOrderId(null);
                      return `Order ${order.orderNo} voided.`;
                    })
                  }
                >
                  Void order
                </Button>
              </Card>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
