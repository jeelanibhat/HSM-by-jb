import { Injectable } from '@nestjs/common';

/**
 * One availability/rate fact for a channel, in the channel's OWN vocabulary.
 *
 * By the time an update reaches a connector it has already been translated: the room
 * type is an `externalRoomCode`, the rate plan an `externalRateCode`. A connector never
 * sees one of our ids, and never needs to — it speaks only to its OTA.
 */
export interface AriUpdate {
  externalRoomCode: string;
  externalRateCode: string | null;
  /** ISO date (YYYY-MM-DD). One update per night. */
  date: string;
  /** Rooms of this type still sellable on this date. */
  available: number;
  /** The night's rate in minor units, if a rate plan is mapped. */
  priceMinor: number | null;
}

/** The minimum a connector needs to know about which channel it is talking to. */
export interface ConnectorTarget {
  channelId: string;
  code: string;
  credentials: Record<string, unknown>;
}

/**
 * The seam between us and an OTA.
 *
 * Everything OTA-specific — the wire format, the auth, the retries at the HTTP layer —
 * lives behind this. The rest of the module deals only in our own model and this
 * interface, which is what lets a simulated channel and a real one be swapped without
 * touching a service.
 */
export interface ChannelConnector {
  /**
   * Push the current availability/rates for a room type. A push is a full snapshot for
   * the dates it covers, not a delta — so a dropped or out-of-order push is corrected by
   * the next one. May throw: a channel being unreachable is normal, and the caller (the
   * sync relay) turns a throw into a retry with back-off.
   */
  pushAri(target: ConnectorTarget, updates: AriUpdate[]): Promise<void>;

  // pullReservations(target): Promise<OtaBooking[]>
  //   A real connector also polls (or receives a webhook of) new bookings. In this
  //   slice inbound is driven by the `simulateChannelBooking` mutation instead, so the
  //   pull side is intentionally absent until a real OTA is wired up.
}

/** DI token — bind the interface so a real connector can replace the simulated one. */
export const CHANNEL_CONNECTOR = Symbol('CHANNEL_CONNECTOR');

/**
 * A stand-in OTA that lives entirely in this process.
 *
 * It does not talk to anything. Instead it REMEMBERS the last availability it was told,
 * per channel and external room code, so the rest of the system — the UI, the tests —
 * can read back "what does the channel currently believe?" and prove the push happened.
 * That is the whole point of the simulator: it makes an outbound push observable without
 * a network on the other end.
 *
 * A real connector keeps none of this; its state lives on the OTA.
 */
@Injectable()
export class SimulatedOtaConnector implements ChannelConnector {
  /** channelId → externalRoomCode → date → the last update seen. */
  private readonly memory = new Map<string, Map<string, Map<string, AriUpdate>>>();

  /**
   * A hook for tests: set a channel code to fail its next push, to exercise the relay's
   * retry/back-off without a real outage.
   */
  private readonly failing = new Set<string>();

  pushAri(target: ConnectorTarget, updates: AriUpdate[]): Promise<void> {
    if (this.failing.has(target.channelId)) {
      this.failing.delete(target.channelId);
      return Promise.reject(new Error(`Simulated channel ${target.code} is unreachable`));
    }

    const byRoom = this.memory.get(target.channelId) ?? new Map<string, Map<string, AriUpdate>>();

    for (const u of updates) {
      const byDate = byRoom.get(u.externalRoomCode) ?? new Map<string, AriUpdate>();
      byDate.set(u.date, u);
      byRoom.set(u.externalRoomCode, byDate);
    }

    this.memory.set(target.channelId, byRoom);
    return Promise.resolve();
  }

  /** What the channel currently believes for a channel, flattened. Test/UI read side. */
  currentAri(channelId: string): AriUpdate[] {
    const byRoom = this.memory.get(channelId);
    if (!byRoom) return [];

    const out: AriUpdate[] = [];
    for (const byDate of byRoom.values()) {
      for (const u of byDate.values()) out.push(u);
    }
    return out.sort((a, b) =>
      a.externalRoomCode === b.externalRoomCode
        ? a.date.localeCompare(b.date)
        : a.externalRoomCode.localeCompare(b.externalRoomCode),
    );
  }

  /** Arrange for the next push to this channel to fail once. Tests only. */
  failNextPush(channelId: string): void {
    this.failing.add(channelId);
  }

  /** Forget everything. Tests call this between cases; the process outlives them. */
  reset(): void {
    this.memory.clear();
    this.failing.clear();
  }
}
