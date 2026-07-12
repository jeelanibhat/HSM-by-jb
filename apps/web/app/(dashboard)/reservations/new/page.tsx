'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, PageHeader } from '@/components/ui';
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
      <>
        <PageHeader title="New booking" crumb="Operations" />

        <Card className="max-w-md text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-success-soft text-2xl text-success">
            ✓
          </div>

          <p className="mt-4 text-sm text-muted">Booking confirmed</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums text-success">
            {done.confirmationNo}
          </p>

          {/* Say plainly that no physical room is held yet — a clerk who assumes one
              was assigned will not notice until the guest is standing there. */}
          <p className="mx-auto mt-3 max-w-xs text-xs text-muted">
            A room <strong className="font-semibold text-ink">type</strong> has been held. Assign a
            physical room from the front desk or the tape chart before check-in.
          </p>

          <div className="mt-5 flex justify-center gap-2">
            <Button onClick={() => router.push('/front-desk')}>Go to front desk</Button>
            <Button
              variant="outline"
              onClick={() => {
                setDone(null);
                setGuest(null);
                setNewGuest({ firstName: '', lastName: '', email: '', phone: '' });
                setNotes('');
              }}
            >
              Take another
            </Button>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New booking" crumb="Operations" />
      <div className="max-w-3xl space-y-5">

      {!canBook && (
        <p className="rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
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
            <div className="rounded-lg border border-line px-2 py-1.5 text-sm tabular-nums text-muted">
              {validDates ? nights(arrival, departure) : '—'}
            </div>
          </Field>
        </div>

        {arrival && departure && nights(arrival, departure) < 1 && (
          <p className="mt-1.5 text-xs text-danger">
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
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${
                  roomTypeId === t.id
                    ? 'border-brand bg-brand-50'
                    : 'border-line'
                } ${soldOut ? 'cursor-not-allowed opacity-40' : ''}`}
              >
                {/* Name it explicitly. Composed from the spans, the accessible name comes
                    out as "Suite SUITE up to 4 3 free" — which is what a screen reader
                    would read aloud, and it is not a sentence. */}
                <input
                  type="radio"
                  name="roomType"
                  aria-label={`${t.name} ${t.code}, up to ${t.maxOccupancy} guests, ${
                    !validDates ? 'choose dates first' : soldOut ? 'sold out' : `${free} free`
                  }`}
                  disabled={soldOut}
                  checked={roomTypeId === t.id}
                  onChange={() => setRoomTypeId(t.id)}
                  className="accent-current"
                />
                <span className="font-medium">{t.name}</span>
                <span className="text-xs text-muted">{t.code}</span>
                <span className="text-xs text-muted">up to {t.maxOccupancy}</span>

                <span className="ml-auto text-xs tabular-nums">
                  {!validDates ? (
                    <span className="opacity-40">—</span>
                  ) : soldOut ? (
                    <span className="text-danger">sold out</span>
                  ) : (
                    <span className="text-success">{free} free</span>
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
          {quoting && <p className="text-xs text-muted">Pricing…</p>}

          {quote && quote.unpricedDates.length > 0 && (
            <div className="rounded bg-danger-soft px-3 py-2 text-xs text-danger">
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
                <div key={n.date} className="flex justify-between tabular-nums text-xs text-muted">
                  <span>{n.date}</span>
                  <span>{formatMinorPlain(n.priceMinor)}</span>
                </div>
              ))}

              <div className="flex justify-between border-t border-line pt-1.5 tabular-nums">
                <span className="text-muted">
                  Subtotal · {quote.nights} night{quote.nights > 1 ? 's' : ''}
                </span>
                <span>{formatMinorPlain(quote.subtotalMinor)}</span>
              </div>
              <div className="flex justify-between tabular-nums text-muted">
                <span>Tax</span>
                <span>{formatMinorPlain(quote.taxMinor)}</span>
              </div>
              <div className="flex justify-between border-t border-line pt-1.5 text-base font-semibold tabular-nums">
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

        {error && <Alert tone="danger">{error}</Alert>}

        <div className="flex items-center gap-3 pb-2">
          <Button onClick={() => void submit()} disabled={!ready || booking}>
            {booking
              ? 'Booking…'
              : quote
                ? `Book · ${formatMinor(quote.totalMinor, quote.currency)}`
                : 'Book'}
          </Button>

          {guest?.blacklisted && (
            <p className="text-xs text-danger">This guest is blacklisted at this property.</p>
          )}
        </div>
      </div>
    </>
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
      <div className="flex items-center gap-2 rounded-lg border border-brand/40 bg-brand-50 px-3 py-2 text-sm">
        <span className="font-medium">
          {guest.firstName} {guest.lastName}
        </span>
        {guest.vip && (
          <span className="rounded bg-warning-soft px-1 text-[9px] font-medium text-warning">
            VIP
          </span>
        )}
        {guest.blacklisted && (
          <span className="rounded bg-danger-soft px-1 text-[9px] font-medium text-danger">
            BLACKLISTED
          </span>
        )}
        <span className="text-xs text-muted">{guest.email ?? guest.phone}</span>
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
        <div className="divide-y divide-line rounded-lg border border-line">
          {data!.searchGuests.map((g) => (
            <button
              key={g.id}
              onClick={() => onPick(g)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-canvas"
            >
              <span className="font-medium">
                {g.firstName} {g.lastName}
              </span>
              {g.vip && <span className="text-[9px] text-warning">VIP</span>}
              {g.blacklisted && (
                <span className="text-[9px] text-danger">BLACKLISTED</span>
              )}
              <span className="ml-auto text-xs text-muted">{g.email ?? g.phone}</span>
            </button>
          ))}
        </div>
      )}

      <p className="pt-1 text-[10px] font-medium uppercase tracking-wide text-muted">or a new guest</p>

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
  'w-full rounded-lg border border-line bg-transparent px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted/60 focus:border-brand';

/** Each step of the booking is its own card — a wall of inputs is how a clerk
 *  mis-keys a date and only finds out at check-in. */
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
    <Card>
      <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-muted">
        {title}
        {hint && <span className="ml-1.5 normal-case text-muted/70">— {hint}</span>}
      </h2>
      {children}
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
    </label>
  );
}
