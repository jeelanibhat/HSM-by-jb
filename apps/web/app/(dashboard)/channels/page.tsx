'use client';

import { useMutation, useQuery } from '@apollo/client';
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { formatMinorPlain } from '@/lib/money';
import {
  CHANNEL_BOOKINGS,
  CHANNELS_SETUP,
  RESYNC_CHANNEL,
  SET_CHANNEL_ENABLED,
  SIMULATE_BOOKING,
  SIMULATED_ARI,
  type Channel,
  type ChannelBooking,
  type RoomType,
  type SimulatedAri,
} from '@/lib/graphql/channels';

/**
 * The channel manager.
 *
 * This screen is where a hotel connects the online travel agents it sells through, tells
 * each one which of our rooms is which, and watches two things flow:
 *
 *   OUT — availability. Every direct booking closes rooms on the channels; this page can
 *         force a full push ("Sync now") and shows what the channel currently believes.
 *   IN  — bookings. An OTA hands us a reservation; it appears on the front desk like any
 *         other, and here in the delivery log with its outcome.
 *
 * "Simulate a booking" stands in for a real OTA delivering one over the wire — the same
 * ingestion path, driven by hand so the loop is visible without a live channel.
 */
export default function ChannelsPage() {
  const [banner, setBanner] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, loading, error, refetch } = useQuery<{ channels: Channel[]; roomTypes: RoomType[] }>(
    CHANNELS_SETUP,
    { fetchPolicy: 'cache-and-network' },
  );

  const channels = data?.channels ?? [];
  const roomTypes = data?.roomTypes ?? [];
  const channel = channels[0] ?? null;

  const { data: bookingsData, refetch: refetchBookings } = useQuery<{
    channelBookings: ChannelBooking[];
  }>(CHANNEL_BOOKINGS, {
    variables: { channelId: channel?.id },
    skip: !channel,
    fetchPolicy: 'cache-and-network',
  });

  const { data: ariData, refetch: refetchAri } = useQuery<{ simulatedAri: SimulatedAri[] }>(
    SIMULATED_ARI,
    { variables: { channelId: channel?.id }, skip: !channel, fetchPolicy: 'cache-and-network' },
  );

  const [setEnabled] = useMutation(SET_CHANNEL_ENABLED);
  const [resync] = useMutation(RESYNC_CHANNEL);
  const [simulate] = useMutation(SIMULATE_BOOKING);

  const run = async (fn: () => Promise<string>) => {
    setBanner(null);
    setBusy(true);
    try {
      const text = await fn();
      await Promise.all([refetch(), refetchBookings(), refetchAri()]);
      if (text) setBanner({ tone: 'success', text });
    } catch (e) {
      setBanner({ tone: 'danger', text: e instanceof Error ? e.message : 'That did not work' });
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <Spinner label="Loading channels…" />;
  if (error) return <Alert tone="danger">{error.message}</Alert>;

  if (!channel) {
    return (
      <>
        <PageHeader title="Channels" crumb="Distribution" />
        <EmptyState>No channels are connected yet.</EmptyState>
      </>
    );
  }

  const nameOf = (roomTypeId: string) => roomTypes.find((t) => t.id === roomTypeId)?.name ?? roomTypeId;
  const bookings = bookingsData?.channelBookings ?? [];
  const ari = ariData?.simulatedAri ?? [];

  return (
    <>
      <PageHeader title="Channels" crumb="Distribution" />

      <div className="space-y-5">
        {banner && (
          <Alert tone={banner.tone} onDismiss={() => setBanner(null)}>
            {banner.text}
          </Alert>
        )}

        <Card>
          <CardHeader
            title={channel.name}
            hint={channel.code}
            action={
              <div className="flex items-center gap-2">
                <Badge tone={channel.enabled ? 'success' : 'neutral'}>
                  {channel.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                <Button
                  size="sm"
                  variant={channel.enabled ? 'outline' : 'success'}
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await setEnabled({
                        variables: { input: { channelId: channel.id, enabled: !channel.enabled } },
                      });
                      return channel.enabled ? `${channel.name} disabled.` : `${channel.name} enabled.`;
                    })
                  }
                >
                  {channel.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || !channel.enabled}
                  onClick={() =>
                    run(async () => {
                      const res = await resync({ variables: { input: { channelId: channel.id } } });
                      const n = res.data.resyncChannel.queued as number;
                      return `Queued a full push for ${n} room type${n === 1 ? '' : 's'}.`;
                    })
                  }
                >
                  Sync now
                </Button>
              </div>
            }
          />

          <Table>
            <thead>
              <tr>
                <Th>Room type</Th>
                <Th>Channel code</Th>
              </tr>
            </thead>
            <tbody>
              {channel.roomTypeMappings.map((m) => (
                <tr key={m.roomTypeId}>
                  <Td>{nameOf(m.roomTypeId)}</Td>
                  <Td className="font-mono text-[13px]">{m.externalRoomCode}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <SimulateBookingCard
            channel={channel}
            busy={busy}
            onSubmit={(input, label) =>
              run(async () => {
                const res = await simulate({ variables: { input } });
                const r = res.data.simulateChannelBooking as {
                  outcome: string;
                  confirmationNo: string | null;
                  reason: string | null;
                };
                if (r.outcome === 'CONFIRMED') return `${label} booked as ${r.confirmationNo}.`;
                if (r.outcome === 'DUPLICATE') return `Already had that booking — nothing changed.`;
                throw new Error(r.reason ?? 'The booking was rejected.');
              })
            }
          />

          <Card>
            <CardHeader
              title="What SimTrip sees"
              hint="The availability last pushed to the channel"
            />
            {ari.length === 0 ? (
              <EmptyState>Nothing pushed yet. Book a room, then Sync now.</EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Room</Th>
                    <Th>Date</Th>
                    <Th className="text-right">Free</Th>
                    <Th className="text-right">Rate</Th>
                  </tr>
                </thead>
                <tbody>
                  {ari.slice(0, 12).map((a) => (
                    <tr key={`${a.externalRoomCode}-${a.date}`}>
                      <Td className="font-mono text-[13px]">{a.externalRoomCode}</Td>
                      <Td className="tabular-nums">{a.date}</Td>
                      <Td className="text-right tabular-nums">{a.available}</Td>
                      <Td className="text-right tabular-nums">
                        {a.priceMinor !== null ? `₹${formatMinorPlain(a.priceMinor)}` : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader title="Inbound bookings" hint="What the channel has delivered" />
          {bookings.length === 0 ? (
            <EmptyState>No bookings from this channel yet.</EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Reference</Th>
                  <Th>Status</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <Td className="font-mono text-[13px]">{b.externalRef}</Td>
                    <Td>
                      <Badge tone={bookingTone(b.status)}>{b.status}</Badge>
                    </Td>
                    <Td className="text-muted">{b.reason ?? (b.reservationId ? 'On the board' : '—')}</Td>
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

function bookingTone(status: ChannelBooking['status']): 'success' | 'danger' | 'neutral' | 'info' {
  if (status === 'CONFIRMED') return 'success';
  if (status === 'REJECTED') return 'danger';
  if (status === 'DUPLICATE') return 'info';
  return 'neutral';
}

/** The "an OTA just sold a room" form. */
function SimulateBookingCard({
  channel,
  busy,
  onSubmit,
}: {
  channel: Channel;
  busy: boolean;
  onSubmit: (
    input: Record<string, unknown>,
    label: string,
  ) => void;
}) {
  const firstRoom = channel.roomTypeMappings[0]?.externalRoomCode ?? '';
  const rateCode = channel.ratePlanMappings[0]?.externalRateCode ?? '';

  const [roomCode, setRoomCode] = useState(firstRoom);
  const [firstName, setFirstName] = useState('Olivia');
  const [lastName, setLastName] = useState('Traveller');
  const [arrival, setArrival] = useState('2026-07-20');
  const [departure, setDeparture] = useState('2026-07-22');

  const submit = () => {
    const externalRef = `SIM-${Date.now()}`;
    onSubmit(
      {
        channelId: channel.id,
        externalRef,
        externalRoomCode: roomCode,
        externalRateCode: rateCode,
        firstName,
        lastName,
        arrivalDate: arrival,
        departureDate: departure,
        adults: 2,
        children: 0,
      },
      `${firstName} ${lastName}`,
    );
  };

  return (
    <Card>
      <CardHeader title="Simulate a booking" hint="As if the channel delivered it" />
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </Field>
          <Field label="Last name">
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </Field>
        </div>
        <Field label="Room (channel code)">
          <Select value={roomCode} onChange={(e) => setRoomCode(e.target.value)}>
            {channel.roomTypeMappings.map((m) => (
              <option key={m.externalRoomCode} value={m.externalRoomCode}>
                {m.externalRoomCode}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Arrival">
            <Input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} />
          </Field>
          <Field label="Departure">
            <Input type="date" value={departure} onChange={(e) => setDeparture(e.target.value)} />
          </Field>
        </div>
        <Button
          variant="primary"
          disabled={busy || !channel.enabled || !roomCode}
          onClick={submit}
          className="w-full"
        >
          Send booking
        </Button>
        {!channel.enabled && (
          <p className="text-xs text-muted">Enable the channel to take bookings from it.</p>
        )}
      </div>
    </Card>
  );
}
