'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { formatMinor, formatMinorPlain } from '@/lib/money';
import {
  AVAILABILITY,
  BOOKING_OPTIONS,
  CREATE_RESERVATION,
  QUOTE,
  SEARCH_GUESTS,
  SOURCES,
  type AvailabilityRow,
  type GuestHit,
  type Quote,
  type RatePlan,
  type RoomType,
} from '@/lib/graphql/booking';
import { CURRENT_PROPERTY, type Property } from '@/lib/graphql/operations';

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nights(a: string, d: string): number {
  return Math.round(
    (new Date(`${d}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/**
 * Take a booking.
 *
 * Two things this screen refuses to do:
 *
 *   1. It does not PRICE the stay. The total comes from the server, computed by the
 *      same code that will later post the charges. A browser that summed the nightly
 *      rates and estimated GST would eventually quote one number at the desk and bill
 *      another at check-out — and the guest would be right to be angry.
 *
 *   2. It does not offer a room type it knows is full. Availability is shown per
 *      type across the exact stay, and a sold-out type cannot be selected. The server
 *      refuses anyway; this just means nobody promises a guest a room that is gone.
 */
export default function NewReservationPage() {
  const { role } = useAuth();
  const router = useRouter();

  const { data: prop } = useQuery<{ currentProperty: Property | null }>(CURRENT_PROPERTY);
  const businessDate = prop?.currentProperty?.businessDate;

  const [arrival, setArrival] = useState('');
  const [departure, setDeparture] = useState('');

  // Default to a one-night stay from the BUSINESS date — a walk-in is the commonest
  // booking, and the business date is the hotel's "today".
  useEffect(() => {
    if (businessDate && !arrival) {
      setArrival(businessDate);
      setDeparture(addDays(businessDate, 1));
    }
  }, [businessDate, arrival]);

  const [roomTypeId, setRoomTypeId] = useState('');
  const [ratePlanId, setRatePlanId] = useState('');
  const [source, setSource] = useState<string>('PHONE');
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [notes, setNotes] = useState('');

  const [guest, setGuest] = useState<GuestHit | null>(null);
  const [newGuest, setNewGuest] = useState({ firstName: '', lastName: '', email: '', phone: '' });

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ confirmationNo: string } | null>(null);

  const { data: options } = useQuery<{ roomTypes: RoomType[]; ratePlans: RatePlan[] }>(
    BOOKING_OPTIONS,
  );

  useEffect(() => {
    if (!ratePlanId && options?.ratePlans[0]) setRatePlanId(options.ratePlans[0].id);
  }, [options, ratePlanId]);

  const validDates = Boolean(arrival && departure && nights(arrival, departure) >= 1);

  const { data: avail } = useQuery<{ availability: AvailabilityRow[] }>(AVAILABILITY, {
    variables: { from: arrival, to: departure ? addDays(departure, -1) : arrival },
    skip: !validDates,
    fetchPolicy: 'cache-and-network',
  });

  /**
   * A room type is bookable only if EVERY night of the stay has a room left. The
   * minimum across the range is the number that matters — one full night in the
   * middle makes the whole stay impossible.
   */
  const availabilityByType = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of avail?.availability ?? []) {
      const current = map.get(row.roomTypeId);
      map.set(row.roomTypeId, current === undefined ? row.available : Math.min(current, row.available));
    }
    return map;
  }, [avail]);

  const { data: quoteData, loading: quoting } = useQuery<{ quote: Quote }>(QUOTE, {
    variables: { roomTypeId, ratePlanId, arrivalDate: arrival, departureDate: departure },
    skip: !validDates || !roomTypeId || !ratePlanId,
  });

  const quote = quoteData?.quote;

  const [create, { loading: booking }] = useMutation(CREATE_RESERVATION);

  const canBook = role === 'ADMIN' || role === 'MANAGER' || role === 'FRONT_DESK';

  const guestReady = guest
    ? !guest.blacklisted
    : newGuest.firstName.trim() !== '' && newGuest.lastName.trim() !== '';

  const typeAvailable = (availabilityByType.get(roomTypeId) ?? 0) > 0;

  const ready =
    canBook &&
    validDates &&
    roomTypeId &&
    ratePlanId &&
    guestReady &&
    typeAvailable &&
    (quote?.unpricedDates.length ?? 0) === 0;

  const submit = async () => {
    setError(null);

    try {
      const { data } = await create({
        variables: {
          input: {
            ...(guest
              ? { guestId: guest.id }
              : {
                  guest: {
                    firstName: newGuest.firstName.trim(),
                    lastName: newGuest.lastName.trim(),
                    ...(newGuest.email.trim() ? { email: newGuest.email.trim() } : {}),
                    ...(newGuest.phone.trim() ? { phone: newGuest.phone.trim() } : {}),
                  },
                }),
            source,
            arrivalDate: arrival,
            departureDate: departure,
            rooms: [{ roomTypeId, ratePlanId, adults, children }],
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          },
        },
      });

      setDone({ confirmationNo: data.createReservation.confirmationNo });
    } catch (e) {
      // The server refuses an overbooking with the night that is full named in the
      // message — "No availability for that room type on 2026-07-14". Verbatim.
      setError(e instanceof Error ? e.message : 'Could not take that booking');
    }
  };

  if (done) {
    return (
      <div className="max-w-md space-y-4">
        <div className="rounded-md border border-status-vacant-clean/30 bg-status-vacant-clean/5 p-6 text-center">
          <p className="text-sm opacity-70">Booking confirmed</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-status-vacant-clean">
            {done.confirmationNo}
          </p>
          <p className="mt-2 text-xs opacity-60">
            A room type has been held. Assign a physical room from the front desk or the tape
            chart before check-in.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => router.push('/front-desk')}
            className="rounded-md bg-status-occupied px-3 py-2 text-sm font-medium text-white"
          >
            Go to front desk
          </button>
          <button
            onClick={() => {
              setDone(null);
              setGuest(null);
              setNewGuest({ firstName: '', lastName: '', email: '', phone: '' });
              setNotes('');
            }}
            className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
          >
            Take another booking
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New reservation</h1>
        <p className="mt-1 text-sm opacity-60">
          Business date <strong className="font-medium">{businessDate ?? '…'}</strong>
        </p>
      </div>

      {!canBook && (
        <p className="rounded-md bg-status-ooo/10 px-4 py-3 text-sm text-status-ooo">
          Your role cannot take bookings.
        </p>
      )}

      {/* ── Stay ── */}
      <Section title="Stay">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Arrival">
            <input
              type="date"
              value={arrival}
              onChange={(e) => {
                setArrival(e.target.value);
                if (departure && nights(e.target.value, departure) < 1) {
                  setDeparture(addDays(e.target.value, 1));
                }
              }}
              className={inputCls}
            />
          </Field>

          <Field label="Departure">
            <input
              type="date"
              value={departure}
              min={arrival ? addDays(arrival, 1) : undefined}
              onChange={(e) => setDeparture(e.target.value)}
              className={inputCls}
            />
          </Field>

          <Field label="Nights">
            <div className="rounded-md border border-black/10 px-2 py-1.5 text-sm tabular-nums opacity-70 dark:border-white/10">
              {validDates ? nights(arrival, departure) : '—'}
            </div>
          </Field>
        </div>

        {arrival && departure && nights(arrival, departure) < 1 && (
          <p className="mt-1.5 text-xs text-status-ooo">
            Departure must be after arrival. A stay is at least one night.
          </p>
        )}
      </Section>

      {/* ── Room type: availability is shown, sold-out types cannot be picked ── */}
      <Section title="Room type" hint="fewest rooms free on any night of the stay">
        <div className="space-y-1.5">
          {(options?.roomTypes ?? []).map((t) => {
            const free = availabilityByType.get(t.id) ?? 0;
            const soldOut = validDates && free === 0;

            return (
              <label
                key={t.id}
                className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm ${
                  roomTypeId === t.id
                    ? 'border-status-occupied bg-status-occupied/5'
                    : 'border-black/10 dark:border-white/10'
                } ${soldOut ? 'cursor-not-allowed opacity-40' : ''}`}
              >
                <input
                  type="radio"
                  name="roomType"
                  disabled={soldOut}
                  checked={roomTypeId === t.id}
                  onChange={() => setRoomTypeId(t.id)}
                  className="accent-current"
                />
                <span className="font-medium">{t.name}</span>
                <span className="text-xs opacity-50">{t.code}</span>
                <span className="text-xs opacity-50">up to {t.maxOccupancy}</span>

                <span className="ml-auto text-xs tabular-nums">
                  {!validDates ? (
                    <span className="opacity-40">—</span>
                  ) : soldOut ? (
                    <span className="text-status-ooo">sold out</span>
                  ) : (
                    <span className="text-status-vacant-clean">{free} free</span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </Section>

      <Section title="Rate plan">
        <select
          value={ratePlanId}
          onChange={(e) => setRatePlanId(e.target.value)}
          className={inputCls}
        >
          {(options?.ratePlans ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.code} · {p.mealPlan})
            </option>
          ))}
        </select>
      </Section>

      {/* ── The quote. Server-computed, never summed here. ── */}
      {validDates && roomTypeId && ratePlanId && (
        <Section title="Quote" hint="priced by the server">
          {quoting && <p className="text-xs opacity-50">Pricing…</p>}

          {quote && quote.unpricedDates.length > 0 && (
            <div className="rounded bg-status-ooo/10 px-3 py-2 text-xs text-status-ooo">
              <p className="font-medium">
                {quote.unpricedDates.length} night
                {quote.unpricedDates.length > 1 ? 's have' : ' has'} no rate loaded.
              </p>
              <p className="mt-0.5 opacity-90">
                {quote.unpricedDates.join(', ')} — a manager must price {quote.unpricedDates.length > 1 ? 'them' : 'it'} before this stay can be booked.
              </p>
            </div>
          )}

          {quote && quote.unpricedDates.length === 0 && (
            <div className="space-y-1 text-sm">
              {quote.nightly.map((n) => (
                <div key={n.date} className="flex justify-between tabular-nums text-xs opacity-70">
                  <span>{n.date}</span>
                  <span>{formatMinorPlain(n.priceMinor)}</span>
                </div>
              ))}

              <div className="flex justify-between border-t border-black/10 pt-1.5 tabular-nums dark:border-white/10">
                <span className="opacity-70">
                  Subtotal · {quote.nights} night{quote.nights > 1 ? 's' : ''}
                </span>
                <span>{formatMinorPlain(quote.subtotalMinor)}</span>
              </div>
              <div className="flex justify-between tabular-nums opacity-70">
                <span>Tax</span>
                <span>{formatMinorPlain(quote.taxMinor)}</span>
              </div>
              <div className="flex justify-between border-t border-black/10 pt-1.5 text-base font-semibold tabular-nums dark:border-white/10">
                <span>Total</span>
                <span>{formatMinor(quote.totalMinor, quote.currency)}</span>
              </div>
            </div>
          )}
        </Section>
      )}

      {/* ── Guest ── */}
      <Section title="Guest">
        <GuestPicker
          guest={guest}
          onPick={setGuest}
          newGuest={newGuest}
          onNewGuest={setNewGuest}
        />
      </Section>

      <Section title="Details">
        <div className="grid grid-cols-4 gap-3">
          <Field label="Adults">
            <input
              type="number"
              min={1}
              max={10}
              value={adults}
              onChange={(e) => setAdults(Number(e.target.value))}
              className={inputCls}
            />
          </Field>
          <Field label="Children">
            <input
              type="number"
              min={0}
              max={10}
              value={children}
              onChange={(e) => setChildren(Number(e.target.value))}
              className={inputCls}
            />
          </Field>
          <Field label="Source">
            <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
              {SOURCES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Notes">
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="optional"
              className={inputCls}
            />
          </Field>
        </div>
      </Section>

      {error && (
        <div role="alert" className="rounded-md bg-status-ooo/10 px-4 py-3 text-sm text-status-ooo">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void submit()}
          disabled={!ready || booking}
          className="rounded-md bg-status-occupied px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {booking ? 'Booking…' : quote ? `Book · ${formatMinor(quote.totalMinor, quote.currency)}` : 'Book'}
        </button>

        {guest?.blacklisted && (
          <p className="text-xs text-status-ooo">
            This guest is blacklisted at this property.
          </p>
        )}
      </div>
    </div>
  );
}

function GuestPicker({
  guest,
  onPick,
  newGuest,
  onNewGuest,
}: {
  guest: GuestHit | null;
  onPick: (g: GuestHit | null) => void;
  newGuest: { firstName: string; lastName: string; email: string; phone: string };
  onNewGuest: (g: { firstName: string; lastName: string; email: string; phone: string }) => void;
}) {
  const [query, setQuery] = useState('');

  const { data } = useQuery<{ searchGuests: GuestHit[] }>(SEARCH_GUESTS, {
    variables: { query },
    skip: query.trim().length < 2,
  });

  if (guest) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-status-occupied/40 bg-status-occupied/5 px-3 py-2 text-sm">
        <span className="font-medium">
          {guest.firstName} {guest.lastName}
        </span>
        {guest.vip && (
          <span className="rounded bg-status-vacant-dirty/20 px-1 text-[9px] font-medium text-status-vacant-dirty">
            VIP
          </span>
        )}
        {guest.blacklisted && (
          <span className="rounded bg-status-ooo/20 px-1 text-[9px] font-medium text-status-ooo">
            BLACKLISTED
          </span>
        )}
        <span className="text-xs opacity-50">{guest.email ?? guest.phone}</span>
        <button
          onClick={() => onPick(null)}
          className="ml-auto text-xs underline opacity-60 hover:opacity-100"
        >
          change
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search a returning guest by name, email or phone…"
        className={inputCls}
      />

      {(data?.searchGuests.length ?? 0) > 0 && (
        <div className="divide-y divide-black/5 rounded-md border border-black/10 dark:divide-white/5 dark:border-white/10">
          {data!.searchGuests.map((g) => (
            <button
              key={g.id}
              onClick={() => onPick(g)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
            >
              <span className="font-medium">
                {g.firstName} {g.lastName}
              </span>
              {g.vip && <span className="text-[9px] text-status-vacant-dirty">VIP</span>}
              {g.blacklisted && (
                <span className="text-[9px] text-status-ooo">BLACKLISTED</span>
              )}
              <span className="ml-auto text-xs opacity-50">{g.email ?? g.phone}</span>
            </button>
          ))}
        </div>
      )}

      <p className="pt-1 text-[10px] uppercase tracking-wide opacity-40">or a new guest</p>

      <div className="grid grid-cols-2 gap-2">
        <input
          value={newGuest.firstName}
          onChange={(e) => onNewGuest({ ...newGuest, firstName: e.target.value })}
          placeholder="First name"
          className={inputCls}
        />
        <input
          value={newGuest.lastName}
          onChange={(e) => onNewGuest({ ...newGuest, lastName: e.target.value })}
          placeholder="Last name"
          className={inputCls}
        />
        <input
          value={newGuest.email}
          onChange={(e) => onNewGuest({ ...newGuest, email: e.target.value })}
          placeholder="Email (optional)"
          className={inputCls}
        />
        <input
          value={newGuest.phone}
          onChange={(e) => onNewGuest({ ...newGuest, phone: e.target.value })}
          placeholder="Phone (optional)"
          className={inputCls}
        />
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-status-occupied dark:border-white/20';

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h2 className="mb-2 text-xs uppercase tracking-wide opacity-50">
        {title}
        {hint && <span className="ml-1.5 normal-case opacity-70">— {hint}</span>}
      </h2>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wide opacity-50">{label}</span>
      {children}
    </label>
  );
}
